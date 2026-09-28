import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeIntentDigest, ReceiptRejected, RevisionConflict, TrajectaStore } from "../src/store.ts";
import { LOCK_DIR, LockConfigError, LockInDoubt, LockTimeout, NestedRootLock, withRootWriteLock } from "../src/lock.ts";
import { clusterJournal } from "../src/clusters.ts";
import type { CloseWorkInput, WorkCloseReceipt } from "../src/types.ts";

const WORKER = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
const local = { kind: "local" as const, name: "Parent", session: "local:parent" };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-lock-"));
}

function run(args: Record<string, unknown>): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      resolve({ code, result: line ? JSON.parse(line) : { stderr } });
    });
  });
}

function openWork(store: TrajectaStore, name: string) {
  return store.open({ operationId: `operation:open-${name}`, topic: name, goal: `Goal ${name}`, surface: local }).work;
}

function deltas(root: string) {
  return fs.readFileSync(path.join(root, "deltas.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("two processes at the same revision: exactly one passes CAS, the other gets RevisionConflict", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "race");
  const barrier = path.join(root, "go");
  const runs = [
    run({ root, action: "capture", name: "a", op: "operation:race-a", workId: work.id, expectedRevision: 1, barrier }),
    run({ root, action: "capture", name: "b", op: "operation:race-b", workId: work.id, expectedRevision: 1, barrier }),
  ];
  setTimeout(() => fs.writeFileSync(barrier, "go"), 400);
  const results = (await Promise.all(runs)).map((item) => item.result);
  assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
  assert.equal(results.find((item) => !item.ok).error, "RevisionConflict");
  assert.equal(store.getWork(work.id).revision, 2, "no last-writer-wins");
  assert.equal(deltas(root).filter((delta) => delta.workId === work.id).length, 2);
  assert.equal(fs.existsSync(path.join(root, LOCK_DIR)), false);
});

test("two processes writing different work items lose nothing", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const first = openWork(store, "first");
  const second = openWork(store, "second");
  const barrier = path.join(root, "go");
  const runs = [
    run({ root, action: "captures", name: "p1", workId: first.id, count: 15, barrier }),
    run({ root, action: "captures", name: "p2", workId: second.id, count: 15, barrier }),
  ];
  setTimeout(() => fs.writeFileSync(barrier, "go"), 400);
  const results = await Promise.all(runs);
  assert.ok(results.every((item) => item.result.ok), JSON.stringify(results));
  assert.equal(store.getWork(first.id).revision, 16);
  assert.equal(store.getWork(second.id).revision, 16);
  assert.equal(deltas(root).length, 32);
  const operations = fs.readFileSync(path.join(root, "operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(operations.filter((record) => record.state === "committed").length, 32);
});

test("two processes appending to domain journals keep journal and projection in step", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const first = openWork(store, "j1");
  const second = openWork(store, "j2");
  const barrier = path.join(root, "go");
  const runs = [
    run({ root, action: "assigns", name: "p1", workId: first.id, count: 15, barrier }),
    run({ root, action: "assigns", name: "p2", workId: second.id, count: 15, barrier }),
  ];
  setTimeout(() => fs.writeFileSync(barrier, "go"), 400);
  const results = await Promise.all(runs);
  assert.ok(results.every((item) => item.result.ok), JSON.stringify(results));
  const journal = clusterJournal(root);
  assert.equal(journal.events().length, 30);
  assert.ok(journal.verify());
});

test("a process that dies holding the lock is recovered on the same host", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "stale");
  const crashed = await run({ root, action: "hold-and-crash" });
  assert.equal(crashed.code, 3);
  assert.ok(fs.existsSync(path.join(root, LOCK_DIR)), "lock left behind by the dead process");
  const next = store.capture({ operationId: "operation:after-stale", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "after" });
  assert.equal(next.work.revision, 2);
  assert.equal(fs.existsSync(path.join(root, LOCK_DIR)), false);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes("stale") || name.includes("recovery")), []);
});

test("a process that dies mid-commit is finished by the next writer", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "midcommit");
  const crashed = await run({ root, action: "capture", name: "dying", op: "operation:dying", workId: work.id, expectedRevision: 1, crashAt: "after-delta" });
  assert.equal(crashed.code, 4);
  assert.equal(store.getWork(work.id).revision, 1, "state not yet written");
  assert.throws(
    () => store.capture({ operationId: "operation:next", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "next" }),
    RevisionConflict,
    "the dead writer's operation is completed first, so revision 1 is stale",
  );
  assert.equal(store.getWork(work.id).revision, 2);
  assert.equal(deltas(root).filter((delta) => delta.operationId === "operation:dying").length, 1);
});

test("an ownerless lock is in doubt and is not removed", async () => {
  const root = tmp();
  const store = new TrajectaStore(root, undefined, undefined, { lock: { timeoutMs: 300 } });
  const work = openWork(store, "ownerless");
  const made = await run({ root, action: "mkdir-only" });
  assert.equal(made.code, 0);
  assert.throws(() => store.capture({ operationId: "operation:blocked", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockInDoubt);
  assert.ok(fs.existsSync(path.join(root, LOCK_DIR)), "ownerless lock kept for a human to inspect");
});

test("a lock owned on another host is never recovered automatically", () => {
  const root = tmp();
  const store = new TrajectaStore(root, undefined, undefined, { lock: { timeoutMs: 300 } });
  const work = openWork(store, "remote");
  fs.mkdirSync(path.join(root, LOCK_DIR));
  fs.writeFileSync(path.join(root, LOCK_DIR, "owner.json"), JSON.stringify({ schema: "trajecta.write-lock/v1", nonce: "n", pid: 999_999, hostname: "some-other-host", acquiredAt: new Date().toISOString() }));
  assert.throws(() => store.capture({ operationId: "operation:remote", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockTimeout);
  assert.ok(fs.existsSync(path.join(root, LOCK_DIR)));
});

test("nested acquisition on the same root is rejected at once", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "nested");
  const started = Date.now();
  assert.throws(() => withRootWriteLock(root, () => store.capture({ operationId: "operation:nested", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" })), NestedRootLock);
  assert.ok(Date.now() - started < 2_000, "no deadlock");
  assert.equal(fs.existsSync(path.join(root, LOCK_DIR)), false, "outer lock released");
  assert.equal(store.getWork(work.id).revision, 1);
});

// --- close --------------------------------------------------------------------

function receiptFor(input: Omit<CloseWorkInput, "operationId" | "surface">, overrides: Partial<WorkCloseReceipt> = {}): WorkCloseReceipt {
  return {
    schema: "trajecta.work-close-receipt/v1",
    id: input.verificationRef,
    purpose: "work_close",
    workId: input.workId,
    expectedRevision: input.expectedRevision,
    status: input.status,
    intentDigest: closeIntentDigest(input),
    authority: "owner",
    evidenceClass: "test",
    outcome: "approved",
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    ...overrides,
  };
}

test("close: complete needs a matching receipt and no open loops; terminal work is frozen", () => {
  const root = tmp();
  const receipts = new Map<string, unknown>();
  const store = new TrajectaStore(root, undefined, undefined, { resolveReceipt: (ref) => receipts.get(ref) });
  let work = openWork(store, "close");
  work = store.capture({ operationId: "operation:loops", workId: work.id, expectedRevision: 1, surface: local, kind: "next_action", summary: "loops", openLoops: ["one"], nextAction: "finish" }).work;
  const base = { workId: work.id, expectedRevision: work.revision, status: "complete" as const, summary: "Done", verificationRef: "receipt:c1", provenance: ["test:all-green"] };
  receipts.set("receipt:c1", receiptFor(base));
  assert.throws(() => store.close({ ...base, operationId: "operation:close-early", surface: local }), /open loop/);
  work = store.capture({ operationId: "operation:clear", workId: work.id, expectedRevision: work.revision, surface: local, kind: "progress", summary: "resolved", openLoops: [] }).work;
  const input = { ...base, expectedRevision: work.revision };
  assert.throws(() => store.close({ ...input, operationId: "operation:close-stale-receipt", surface: local }), ReceiptRejected, "receipt bound to the old revision");
  receipts.set("receipt:c1", receiptFor(input, { purpose: "incident_promotion" as "work_close" }));
  assert.throws(() => store.close({ ...input, operationId: "operation:close-wrong-purpose", surface: local }), /purpose incident_promotion/);
  receipts.set("receipt:c1", receiptFor({ ...input, summary: "Something else" }));
  assert.throws(() => store.close({ ...input, operationId: "operation:close-other-intent", surface: local }), /does not match this close request/);
  receipts.set("receipt:c1", receiptFor(input, { expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.throws(() => store.close({ ...input, operationId: "operation:close-expired", surface: local }), /expired/);
  receipts.set("receipt:c1", receiptFor(input));
  const closed = store.close({ ...input, operationId: "operation:close", surface: local });
  assert.equal(closed.work.status, "complete");
  assert.equal(closed.work.nextAction, null);
  assert.equal(closed.delta.kind, "close");
  assert.ok(closed.delta.provenance.includes("receipt:c1"));
  assert.equal(store.close({ ...input, operationId: "operation:close", surface: local }).delta.id, closed.delta.id, "replay");
  assert.throws(() => store.capture({ operationId: "operation:after", workId: work.id, expectedRevision: closed.work.revision, surface: local, kind: "progress", summary: "x" }), /Terminal/);
  assert.throws(() => store.resume({ operationId: "operation:resume", workId: work.id, expectedRevision: closed.work.revision, surface: local }), /Terminal/);
  const reopened = new TrajectaStore(root);
  assert.equal(reopened.history(work.id).at(-1)!.kind, "close", "delta log with close reads back");
});

test("close: abandoned keeps open loops and needs an authority, not evidence", () => {
  const root = tmp();
  const receipts = new Map<string, unknown>();
  const store = new TrajectaStore(root, undefined, undefined, { resolveReceipt: (ref) => receipts.get(ref) });
  let work = openWork(store, "abandon");
  work = store.capture({ operationId: "operation:loops", workId: work.id, expectedRevision: 1, surface: local, kind: "next_action", summary: "loops", openLoops: ["never done"], nextAction: "later" }).work;
  const input = { workId: work.id, expectedRevision: work.revision, status: "abandoned" as const, summary: "Dropped: superseded", verificationRef: "receipt:a1", provenance: [] };
  receipts.set("receipt:a1", receiptFor(input, { evidenceClass: "", authority: "" }));
  assert.throws(() => store.close({ ...input, operationId: "operation:abandon-no-authority", surface: local }), /authority/);
  receipts.set("receipt:a1", receiptFor(input, { evidenceClass: "" }));
  const closed = store.close({ ...input, operationId: "operation:abandon", surface: local });
  assert.equal(closed.work.status, "abandoned");
  assert.deepEqual(closed.work.openLoops, ["never done"]);
  assert.equal(closed.work.nextAction, null);
});

test("close without a configured verifier is refused", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "noverifier");
  assert.throws(() => store.close({ operationId: "operation:c", workId: work.id, expectedRevision: 1, surface: local, status: "complete", summary: "x", verificationRef: "receipt:x", provenance: ["test:x"] }), /verifier/);
});

test("two processes arriving at one stale lock: exactly one recovers it, nothing is lost", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "dual-recover");
  assert.equal((await run({ root, action: "hold-and-crash" })).code, 3);
  const barrier = path.join(root, "go");
  const runs = [
    run({ root, action: "capture", name: "r1", op: "operation:r1", workId: work.id, expectedRevision: 1, barrier }),
    run({ root, action: "capture", name: "r2", op: "operation:r2", workId: work.id, expectedRevision: 1, barrier }),
  ];
  setTimeout(() => fs.writeFileSync(barrier, "go"), 400);
  const results = (await Promise.all(runs)).map((item) => item.result);
  assert.equal(results.reduce((sum, item) => sum + item.stats.staleRecovered, 0), 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.find((item) => !item.ok).error, "RevisionConflict");
  assert.equal(store.getWork(work.id).revision, 2);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(".trajecta-write-lock")), []);
});

test("journal readers take the lock and never see a half-written append", async () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "readers");
  const journal = clusterJournal(root);
  const writer = run({ root, action: "assigns", name: "w", workId: work.id, count: 60 });
  let reads = 0;
  let finished = false;
  writer.then(() => { finished = true; });
  while (!finished) {
    journal.rebuild();
    journal.events();
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok((await writer).result.ok);
  assert.ok(reads > 0);
  assert.equal(journal.events().length, 60);
  assert.ok(journal.verify());
});

test("lock timing is validated, so a bad value can never mean an endless wait", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = openWork(store, "timing");
  fs.mkdirSync(path.join(root, LOCK_DIR));
  fs.writeFileSync(path.join(root, LOCK_DIR, "owner.json"), JSON.stringify({ schema: "trajecta.write-lock/v1", nonce: "busy", pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }));
  const previous = process.env.TRAJECTA_LOCK_TIMEOUT_MS;
  process.env.TRAJECTA_LOCK_TIMEOUT_MS = "wat";
  try {
    const started = Date.now();
    assert.throws(() => store.capture({ operationId: "operation:t1", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockConfigError);
    assert.ok(Date.now() - started < 1_000, "fails at once instead of hanging under contention");
  } finally {
    if (previous === undefined) delete process.env.TRAJECTA_LOCK_TIMEOUT_MS; else process.env.TRAJECTA_LOCK_TIMEOUT_MS = previous;
  }
  for (const lock of [{ timeoutMs: Number.NaN }, { timeoutMs: -1 }, { timeoutMs: 100, retryMs: 0 }, { timeoutMs: 100, retryMs: Number.POSITIVE_INFINITY }]) {
    const bad = new TrajectaStore(root, undefined, undefined, { lock });
    assert.throws(() => bad.capture({ operationId: "operation:t2", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockConfigError, JSON.stringify(lock));
  }
  const bounded = new TrajectaStore(root, undefined, undefined, { lock: { timeoutMs: 200 } });
  assert.throws(() => bounded.capture({ operationId: "operation:t3", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockTimeout);
});

test("close resolves its receipt outside the root lock", () => {
  const root = tmp();
  const receipts = new Map<string, unknown>();
  let store: TrajectaStore;
  let mutateDuringResolve = false;
  store = new TrajectaStore(root, undefined, undefined, {
    resolveReceipt: (ref) => {
      // A verifier that reads and writes Trajecta itself would dead-lock or
      // hit NestedRootLock if it ran inside the lock.
      store.list();
      clusterJournal(root).append(`operation:verifier-${ref.replace(":", "-")}-${mutateDuringResolve}`, { ref, mutateDuringResolve }, () => ({ type: "assign" as const, workId: workId, cluster: "verified", reason: "checked", surface: local }));
      if (mutateDuringResolve) {
        const current = store.getWork(workId);
        store.capture({ operationId: "operation:sneak", workId, expectedRevision: current.revision, surface: local, kind: "progress", summary: "changed meanwhile" });
      }
      return receipts.get(ref);
    },
  });
  const workId = openWork(store, "outside").id;
  const input = { workId, expectedRevision: 1, status: "complete" as const, summary: "Done", verificationRef: "receipt:o1", provenance: ["test:ok"] };
  receipts.set("receipt:o1", receiptFor(input));
  mutateDuringResolve = true;
  assert.throws(() => store.close({ ...input, operationId: "operation:close-raced", surface: local }), RevisionConflict, "work changed while the receipt was resolved");
  mutateDuringResolve = false;
  const current = store.getWork(workId);
  const next = { ...input, expectedRevision: current.revision };
  receipts.set("receipt:o1", receiptFor(next));
  const closed = store.close({ ...next, operationId: "operation:close-ok", surface: local });
  assert.equal(closed.work.status, "complete");
});

test("a malformed close request never reaches the verifier", () => {
  const root = tmp();
  let calls = 0;
  const store = new TrajectaStore(root, undefined, undefined, { resolveReceipt: () => { calls += 1; return null; } });
  const work = openWork(store, "malformed");
  const good = { operationId: "operation:m", workId: work.id, expectedRevision: 1, surface: local, status: "complete" as const, summary: "Done", verificationRef: "receipt:m1", provenance: ["test:ok"] };
  const bad: Array<Record<string, unknown>> = [
    { status: "finished" },
    { summary: "" },
    { verificationRef: "not a reference" },
    { surface: { kind: "moon", name: "x", session: "y" } },
    { provenance: "test:ok" },
    { provenance: Array.from({ length: 21 }, (_, i) => `test:${i}`) },
    { provenance: [] },
    { expectedRevision: 0 },
    { workId: "nope" },
  ];
  for (const change of bad) {
    assert.throws(() => store.close({ ...good, ...change, operationId: `operation:m-${calls}-${Object.keys(change)[0]}` } as CloseWorkInput), Error, JSON.stringify(change));
  }
  assert.equal(calls, 0, "verifier never called for malformed requests");
  assert.throws(() => store.close(good), ReceiptRejected, "a well-formed request does reach the verifier");
  assert.equal(calls, 1);
});

test("timeoutMs is a hard bound even when retryMs is longer", () => {
  const root = tmp();
  const work = openWork(new TrajectaStore(root), "bound");
  fs.mkdirSync(path.join(root, LOCK_DIR));
  fs.writeFileSync(path.join(root, LOCK_DIR, "owner.json"), JSON.stringify({ schema: "trajecta.write-lock/v1", nonce: "busy", pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() }));
  const store = new TrajectaStore(root, undefined, undefined, { lock: { timeoutMs: 100, retryMs: 5_000 } });
  const started = Date.now();
  assert.throws(() => store.capture({ operationId: "operation:bound", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "x" }), LockTimeout);
  const waited = Date.now() - started;
  assert.ok(waited >= 90 && waited < 1_500, `waited ${waited} ms for a 100 ms timeout`);
});
