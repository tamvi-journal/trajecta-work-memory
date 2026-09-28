/**
 * Root write lock: one writer at a time per store root, across processes.
 *
 * Revision CAS protects against stale callers, but two processes can both
 * read revision N, both pass CAS, and the second `state.json` replace wins.
 * Every mutation of the store and of domain journals therefore runs inside
 * `withRootWriteLock(root, mutation)`:
 *
 *   acquire → replay → recover → re-read → CAS → mutate → commit → release
 *
 * Mechanism (dependency-free, same on macOS, Linux and Windows):
 *
 * - The lock is the directory `<root>/.trajecta-write-lock/`, created with an
 *   atomic `mkdir`. Its `owner.json` holds nonce, pid, hostname and
 *   acquiredAt. Release removes it only when the nonce still matches.
 * - Busy lock → bounded retry → `LockTimeout`.
 * - Ownerless lock (directory without a valid `owner.json`, e.g. a crash
 *   between mkdir and writing the owner) → `LockInDoubt`. It is never deleted
 *   because of a timeout and never treated as a stale lock.
 * - Stale lock: only when the owner is on this host and its pid is dead.
 *   Recovery goes through a second atomic directory
 *   (`.trajecta-write-lock.recovery/`), so only one process recovers at a time;
 *   it re-reads the owner, renames the lock to a quarantine name carrying its
 *   own nonce, and deletes only that quarantine. An owner on another host is
 *   never recovered automatically.
 * - No nesting: acquiring the same root twice in one process throws
 *   `NestedRootLock` immediately instead of deadlocking. Internal helpers run
 *   inside the caller's lock and never acquire it themselves.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCK_DIR = ".trajecta-write-lock";
const RECOVERY_DIR = ".trajecta-write-lock.recovery";
const OWNER_FILE = "owner.json";

export interface LockOwner {
  schema: "trajecta.write-lock/v1";
  nonce: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  /** Test seam: override liveness checks. */
  isAlive?: (pid: number) => boolean;
  hostname?: string;
}

export class LockTimeout extends Error {
  readonly owner: LockOwner | null;
  constructor(root: string, owner: LockOwner | null) {
    super(`Timed out waiting for the write lock on ${root}${owner ? ` (held by pid ${owner.pid} on ${owner.hostname} since ${owner.acquiredAt})` : ""}`);
    this.name = "LockTimeout";
    this.owner = owner;
  }
}

export class LockInDoubt extends Error {
  constructor(message: string) {
    super(`${message}. Inspect it by hand; Trajecta will not remove it automatically`);
    this.name = "LockInDoubt";
  }
}

export class LockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockConfigError";
  }
}

/** Counters for tests and diagnostics (per process). */
export const lockStats = { acquired: 0, staleRecovered: 0 };

export class NestedRootLock extends Error {
  constructor(root: string) {
    super(`Nested write lock on ${root}: this mutation already holds it`);
    this.name = "NestedRootLock";
  }
}

const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms: number) {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function processAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(dir: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), "utf8")) as Partial<LockOwner>;
    if (value?.schema !== "trajecta.write-lock/v1" || typeof value.nonce !== "string" || !Number.isInteger(value.pid)
      || typeof value.hostname !== "string" || typeof value.acquiredAt !== "string") return null;
    return value as LockOwner;
  } catch {
    return null;
  }
}

function writeOwner(dir: string, owner: LockOwner) {
  const temporary = path.join(dir, `${OWNER_FILE}.tmp-${owner.nonce}`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeSync(descriptor, JSON.stringify(owner));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  retrying(() => fs.renameSync(temporary, path.join(dir, OWNER_FILE)));
}

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

/**
 * Windows refuses to delete or rename while another process has a file in
 * the directory open, even for the instant it takes to read owner.json.
 * Retry those transient errors briefly, and confirm the directory is gone.
 */
function retrying<T>(action: () => T, attempts = 40): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      sleep(Math.min(5 * attempt, 50));
    }
  }
}

function removeDir(dir: string) {
  retrying(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 5 });
    if (fs.existsSync(dir)) {
      const error = new Error(`Could not remove ${dir}`) as NodeJS.ErrnoException;
      error.code = "ENOTEMPTY";
      throw error;
    }
  });
}

function tryMkdir(dir: string) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function recoverStale(root: string, observed: LockOwner, nonce: string, options: Required<Pick<LockOptions, "isAlive" | "hostname">>) {
  const lockDir = path.join(root, LOCK_DIR);
  const recoveryDir = path.join(root, RECOVERY_DIR);
  if (!tryMkdir(recoveryDir)) return false; // another process is recovering
  try {
    writeOwner(recoveryDir, { schema: "trajecta.write-lock/v1", nonce, pid: process.pid, hostname: options.hostname, acquiredAt: new Date().toISOString() });
    const current = readOwner(lockDir);
    // Only the exact dead owner we observed may be removed.
    if (!current || current.nonce !== observed.nonce || current.hostname !== options.hostname || options.isAlive(current.pid)) return false;
    const quarantine = path.join(root, `${LOCK_DIR}.stale-${nonce}`);
    try {
      retrying(() => fs.renameSync(lockDir, quarantine));
    } catch (error) {
      if (TRANSIENT.has((error as NodeJS.ErrnoException).code ?? "")) return false; // try again on the next round
      throw error;
    }
    removeDir(quarantine);
    lockStats.staleRecovered += 1;
    return true;
  } finally {
    removeDir(recoveryDir);
  }
}

/**
 * Bounded retry is an invariant, so bad timing values fail closed instead of
 * turning into NaN deadlines that never expire.
 */
export function lockTiming(options: LockOptions, env: NodeJS.ProcessEnv = process.env) {
  let timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) {
    const raw = env.TRAJECTA_LOCK_TIMEOUT_MS;
    timeoutMs = raw === undefined || raw.trim() === "" ? 10_000 : Number(raw);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new LockConfigError(`TRAJECTA_LOCK_TIMEOUT_MS must be a finite number of milliseconds >= 0, got ${JSON.stringify(raw)}`);
  } else if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new LockConfigError(`lock timeoutMs must be a finite number >= 0, got ${String(timeoutMs)}`);
  }
  const retryMs = options.retryMs ?? 15;
  if (typeof retryMs !== "number" || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new LockConfigError(`lock retryMs must be a finite number > 0, got ${String(retryMs)}`);
  }
  return { timeoutMs, retryMs };
}

function acquire(root: string, options: LockOptions): LockOwner {
  const { timeoutMs, retryMs } = lockTiming(options);
  const hostname = options.hostname ?? os.hostname();
  const isAlive = options.isAlive ?? processAlive;
  const lockDir = path.join(root, LOCK_DIR);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const owner: LockOwner = { schema: "trajecta.write-lock/v1", nonce: crypto.randomUUID(), pid: process.pid, hostname, acquiredAt: "" };
  const deadline = Date.now() + timeoutMs;
  let lastOwner: LockOwner | null = null;
  let ownerless = false;
  for (;;) {
    if (tryMkdir(lockDir)) {
      owner.acquiredAt = new Date().toISOString();
      lockStats.acquired += 1;
      try {
        writeOwner(lockDir, owner);
      } catch (error) {
        removeDir(lockDir);
        throw error;
      }
      return owner;
    }
    lastOwner = readOwner(lockDir);
    ownerless = lastOwner === null && fs.existsSync(lockDir);
    if (lastOwner && lastOwner.hostname === hostname && !isAlive(lastOwner.pid)) {
      if (recoverStale(root, lastOwner, owner.nonce, { hostname, isAlive })) continue;
    }
    if (Date.now() >= deadline) {
      const recoveryDir = path.join(root, RECOVERY_DIR);
      if (fs.existsSync(recoveryDir)) throw new LockInDoubt(`A lock recovery at ${recoveryDir} did not finish`);
      // An owner may legitimately be half-written for a moment; only a lock
      // that stays ownerless for the whole wait is in doubt.
      if (ownerless) throw new LockInDoubt(`Write lock ${lockDir} has no valid owner`);
      throw new LockTimeout(root, lastOwner);
    }
    sleep(retryMs);
  }
}

function release(root: string, owner: LockOwner) {
  const lockDir = path.join(root, LOCK_DIR);
  const current = readOwner(lockDir);
  if (!current || current.nonce !== owner.nonce) {
    throw new LockInDoubt(`Write lock ${lockDir} changed owner while it was held`);
  }
  removeDir(lockDir);
}

export function withRootWriteLock<T>(root: string, mutation: () => T, options: LockOptions = {}): T {
  const key = path.resolve(root);
  if (held.has(key)) throw new NestedRootLock(key);
  const owner = acquire(key, options);
  held.add(key);
  try {
    return mutation();
  } finally {
    held.delete(key);
    release(key, owner);
  }
}

/** True while this process holds the lock for `root` (for assertions). */
export function holdsRootWriteLock(root: string) {
  return held.has(path.resolve(root));
}
