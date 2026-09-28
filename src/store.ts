import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withRootWriteLock, type LockOptions } from "./lock.ts";
import type {
  Branch,
  CloseWorkInput,
  CaptureDeltaInput,
  Delta,
  OpenWorkInput,
  RouteMatch,
  Surface,
  TransferPacket,
  WorkCloseReceipt,
  WorkItem,
} from "./types.ts";

interface StateFile {
  schema: "trajecta.state/v1";
  work: WorkItem[];
}

interface OperationRecordLegacy {
  operationId: string;
  digest: string;
  state: "reserved" | "committed";
  deltaId?: string;
  result?: { work: WorkItem; delta: Delta };
}

interface OperationRecordV2 {
  schema: "trajecta.operation/v2";
  operationId: string;
  digest: string;
  state: "reserved" | "committed";
  beforeStateDigest: string;
  nextStateDigest: string;
  delta: Delta;
  nextState: StateFile;
  result: { work: WorkItem; delta: Delta };
}

type OperationRecord = OperationRecordLegacy | OperationRecordV2;

export type StoreFaultPoint = "after-reserve" | "after-delta" | "after-state";

export class RevisionConflict extends Error {
  readonly latest: WorkItem;
  constructor(latest: WorkItem) {
    super(`Revision conflict: expected current revision ${latest.revision}`);
    this.name = "RevisionConflict";
    this.latest = latest;
  }
}

export class OperationConflict extends Error {
  constructor() {
    super("Operation ID was reused with different input");
    this.name = "OperationConflict";
  }
}

export class OperationInDoubt extends Error {
  constructor() {
    super("Operation outcome is ambiguous; inspect durable state before retrying");
    this.name = "OperationInDoubt";
  }
}

function assertText(value: string, label: string, max = 1_000) {
  if (!value?.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
}

function assertId(value: string, label: string) {
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a namespaced opaque ID`);
  }
}

function assertSurface(surface: Surface) {
  if (!surface || !["cloud", "local"].includes(surface.kind)) throw new Error("Surface kind must be cloud or local");
  assertText(surface.name, "Surface name", 120);
  assertText(surface.session, "Surface session", 200);
}

function canonicalStoreJson(value: unknown, stack = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStoreJson(item, stack)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Store digest accepts JSON values only");
  if (stack.has(value)) throw new TypeError("Store digest cannot serialize cyclic values");
  stack.add(value);
  try {
    const entries = Object.keys(value).sort().flatMap((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return [];
      return [`${JSON.stringify(key)}:${canonicalStoreJson(item, stack)}`];
    });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalStoreDigest(value: unknown) {
  return crypto.createHash("sha256").update(canonicalStoreJson(value)).digest("hex");
}

function legacyStoreDigest(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenize(value: string) {
  return [...new Set(value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter((token) => token.length > 1))];
}

export function writeAll(
  descriptor: number,
  bytes: Buffer,
  writer: (descriptor: number, bytes: Buffer, offset: number, length: number) => number = fs.writeSync,
  noProgressMessage = "Operation log write made no progress",
) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error(noProgressMessage);
    offset += written;
  }
}

/**
 * Make a completed create/rename durable by syncing its parent directory.
 *
 * POSIX needs this; Windows does not allow opening a directory for fsync
 * (EPERM) and NTFS journals the metadata change itself. Platform mechanism,
 * not product semantics (cross-platform contract v1, §2).
 */
function syncDirectory(directoryPath: string) {
  if (process.platform === "win32") return;
  const directory = fs.openSync(directoryPath, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function appendJsonl(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(file);
  const descriptor = fs.openSync(file, "a", 0o600);
  try {
    writeAll(descriptor, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  if (!existed) syncDirectory(path.dirname(file));
}

function isSurface(value: unknown): value is Surface {
  const surface = value as Partial<Surface> | null;
  return Boolean(surface)
    && (surface.kind === "cloud" || surface.kind === "local")
    && typeof surface.name === "string"
    && typeof surface.session === "string";
}

function isDelta(value: unknown): value is Delta {
  const delta = value as Partial<Delta> | null;
  return Boolean(delta)
    && typeof delta.id === "string"
    && typeof delta.operationId === "string"
    && typeof delta.workId === "string"
    && Number.isInteger(delta.revision) && delta.revision > 0
    && ["instruction", "decision", "progress", "blocker", "correction", "next_action", "branch_open", "branch_park", "synthesis", "handoff", "outcome", "contract_anchor", "open", "resume", "close"].includes(delta.kind as string)
    && typeof delta.summary === "string"
    && isSurface(delta.surface)
    && (typeof delta.branchId === "string" || delta.branchId === null)
    && (delta.targetSurface === "cloud" || delta.targetSurface === "local" || delta.targetSurface === null)
    && Array.isArray(delta.provenance) && delta.provenance.every((item) => typeof item === "string")
    && typeof delta.createdAt === "string"
    && (delta.contractVersion === undefined || (Number.isInteger(delta.contractVersion) && delta.contractVersion > 0))
    && (delta.previousContractId === undefined || typeof delta.previousContractId === "string" || delta.previousContractId === null);
}

function isBranch(value: unknown): value is Branch {
  const branch = value as Partial<Branch> | null;
  return Boolean(branch)
    && typeof branch.id === "string"
    && typeof branch.label === "string"
    && typeof branch.purpose === "string"
    && Array.isArray(branch.cues) && branch.cues.every((item) => typeof item === "string")
    && typeof branch.returnPoint === "string"
    && ["exploring", "parked", "merged"].includes(branch.status as string)
    && typeof branch.updatedAt === "string";
}

function isWorkItem(value: unknown): value is WorkItem {
  const work = value as Partial<WorkItem> | null;
  return Boolean(work)
    && typeof work.id === "string"
    && typeof work.topic === "string"
    && typeof work.goal === "string"
    && (typeof work.instruction === "string" || work.instruction === null)
    && ["active", "waiting", "blocked", "complete", "abandoned"].includes(work.status as string)
    && Number.isInteger(work.revision) && work.revision > 0
    && (typeof work.activeBranchId === "string" || work.activeBranchId === null)
    && Array.isArray(work.branches) && work.branches.every(isBranch)
    && Array.isArray(work.openLoops)
    && work.openLoops.every((item) => typeof item === "string")
    && (typeof work.nextAction === "string" || work.nextAction === null)
    && isSurface(work.lastSurface)
    && typeof work.createdAt === "string"
    && typeof work.updatedAt === "string";
}

function isStateFile(value: unknown): value is StateFile {
  const state = value as Partial<StateFile> | null;
  return Boolean(state) && state.schema === "trajecta.state/v1" && Array.isArray(state.work) && state.work.every(isWorkItem);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isOperationRecordLegacy(value: unknown): value is OperationRecordLegacy {
  const record = value as Partial<OperationRecordLegacy> | null;
  return Boolean(record)
    && !("schema" in record)
    && typeof record.operationId === "string"
    && isDigest(record.digest)
    && (record.state === "reserved" || record.state === "committed")
    && (record.deltaId === undefined || typeof record.deltaId === "string")
    && (record.result === undefined || (isWorkItem(record.result.work) && isDelta(record.result.delta)));
}

function isOperationRecordV2(value: unknown): value is OperationRecordV2 {
  const record = value as Partial<OperationRecordV2> | null;
  if (!(Boolean(record)
    && record.schema === "trajecta.operation/v2"
    && typeof record.operationId === "string"
    && isDigest(record.digest)
    && (record.state === "reserved" || record.state === "committed")
    && isDigest(record.beforeStateDigest)
    && isDigest(record.nextStateDigest)
    && isDelta(record.delta)
    && isStateFile(record.nextState)
    && Boolean(record.result) && isWorkItem(record.result.work) && isDelta(record.result.delta)
  )) return false;
  const nextWork = record.nextState.work.filter((work) => work.id === record.delta.workId);
  return record.delta.operationId === record.operationId
    && record.result.delta.operationId === record.operationId
    && record.result.work.id === record.delta.workId
    && record.result.work.revision === record.delta.revision
    && nextWork.length === 1
    && record.nextStateDigest === canonicalStoreDigest(record.nextState)
    && canonicalStoreDigest(record.delta) === canonicalStoreDigest(record.result.delta)
    && canonicalStoreDigest(record.result.work) === canonicalStoreDigest(nextWork[0]);
}

function readJsonl<T>(file: string, role: "operations" | "deltas"): T[] {
  if (!fs.existsSync(file)) return [];
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    throw new OperationInDoubt();
  }
  if (!content) return [];
  if (!content.endsWith("\n")) throw new OperationInDoubt();
  try {
    return content.slice(0, -1).split("\n").map((line) => {
      const value: unknown = JSON.parse(line);
      if (role === "operations" ? !(isOperationRecordLegacy(value) || isOperationRecordV2(value)) : !isDelta(value)) {
        throw new OperationInDoubt();
      }
      return value as T;
    });
  } catch (error) {
    if (error instanceof OperationInDoubt) throw error;
    throw new OperationInDoubt();
  }
}

export function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    writeAll(descriptor, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), fs.writeSync, "Atomic file write made no progress");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

/** Digest of a close request, which a work-close receipt must carry. */
export function closeIntentDigest(input: Pick<CloseWorkInput, "workId" | "expectedRevision" | "status" | "summary" | "provenance">) {
  return canonicalStoreDigest({
    workId: input.workId,
    expectedRevision: input.expectedRevision,
    status: input.status,
    summary: input.summary.trim(),
    provenance: [...input.provenance],
  });
}

export class ReceiptRejected extends Error {
  constructor(reason: string) {
    super(`Close receipt rejected: ${reason}`);
    this.name = "ReceiptRejected";
  }
}

function assertWorkCloseReceipt(value: unknown, input: CloseWorkInput, now: Date) {
  const receipt = value as Partial<WorkCloseReceipt> | null | undefined;
  if (!receipt) throw new ReceiptRejected("no receipt found for this reference");
  if (receipt.purpose !== "work_close") throw new ReceiptRejected(`purpose ${String(receipt.purpose)} cannot close work`);
  if (receipt.schema !== "trajecta.work-close-receipt/v1") throw new ReceiptRejected("unsupported schema");
  if (receipt.id !== input.verificationRef) throw new ReceiptRejected("receipt id does not match the reference");
  if (receipt.workId !== input.workId) throw new ReceiptRejected("receipt is for a different work item");
  if (receipt.expectedRevision !== input.expectedRevision) throw new ReceiptRejected("receipt is for a different revision");
  if (receipt.status !== input.status) throw new ReceiptRejected("receipt is for a different terminal status");
  if (receipt.intentDigest !== closeIntentDigest(input)) throw new ReceiptRejected("receipt does not match this close request");
  if (receipt.outcome !== "approved") throw new ReceiptRejected("receipt is not an approval");
  if (typeof receipt.authority !== "string" || !receipt.authority.trim()) throw new ReceiptRejected("receipt names no authority");
  if (input.status === "complete" && (typeof receipt.evidenceClass !== "string" || !receipt.evidenceClass.trim())) {
    throw new ReceiptRejected("closing as complete needs an evidence class");
  }
  const issued = Date.parse(String(receipt.issuedAt));
  if (!Number.isFinite(issued) || issued > now.getTime()) throw new ReceiptRejected("receipt issue time is invalid or in the future");
  if (receipt.expiresAt !== undefined && !(Date.parse(receipt.expiresAt) > now.getTime())) throw new ReceiptRejected("receipt has expired");
}

export class TrajectaStore {
  readonly root: string;
  private readonly stateFile: string;
  private readonly deltaFile: string;
  private readonly operationFile: string;
  private readonly clock: () => Date;
  private readonly fault?: (point: StoreFaultPoint) => void;

  private readonly lockOptions: LockOptions;
  private readonly resolveReceipt?: (reference: string) => unknown;

  constructor(
    root = path.resolve(".trajecta"),
    clock: () => Date = () => new Date(),
    fault?: (point: StoreFaultPoint) => void,
    options: { lock?: LockOptions; resolveReceipt?: (reference: string) => unknown } = {},
  ) {
    this.root = root;
    this.stateFile = path.join(root, "state.json");
    this.deltaFile = path.join(root, "deltas.jsonl");
    this.operationFile = path.join(root, "operations.jsonl");
    this.clock = clock;
    this.fault = fault;
    this.lockOptions = options.lock ?? {};
    this.resolveReceipt = options.resolveReceipt;
  }

  /** Run one mutation under the root write lock (see lock.ts). */
  private locked<T>(mutation: () => T): T {
    return withRootWriteLock(this.root, mutation, this.lockOptions);
  }

  /**
   * Finish every operation that was reserved but never committed, before a
   * new mutation builds on the state. Runs under the root lock.
   */
  private recoverPending() {
    const records = readJsonl<OperationRecord>(this.operationFile, "operations");
    const committed = new Set(records.filter((record) => record.state === "committed").map((record) => record.operationId));
    for (const record of records) {
      if (record.state === "reserved" && "schema" in record && !committed.has(record.operationId)) {
        this.reconcileReservation(record);
        committed.add(record.operationId);
      }
    }
  }

  private readState(): StateFile {
    if (!fs.existsSync(this.stateFile)) return { schema: "trajecta.state/v1", work: [] };
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (!isStateFile(value)) throw new OperationInDoubt();
      return value;
    } catch (error) {
      if (error instanceof OperationInDoubt) throw error;
      throw new OperationInDoubt();
    }
  }

  private commit(beforeState: StateFile, state: StateFile, delta: Delta, input: unknown) {
    const result = {
      work: structuredClone(state.work.find((item) => item.id === delta.workId)!),
      delta: structuredClone(delta),
    };
    const reservation: OperationRecordV2 = {
      schema: "trajecta.operation/v2",
      operationId: delta.operationId,
      digest: canonicalStoreDigest(input),
      state: "reserved",
      beforeStateDigest: canonicalStoreDigest(beforeState),
      nextStateDigest: canonicalStoreDigest(state),
      delta: structuredClone(delta),
      nextState: structuredClone(state),
      result: structuredClone(result),
    };
    appendJsonl(this.operationFile, reservation);
    this.fault?.("after-reserve");
    appendJsonl(this.deltaFile, delta);
    this.fault?.("after-delta");
    writeAtomic(this.stateFile, state);
    this.fault?.("after-state");
    appendJsonl(this.operationFile, { ...reservation, state: "committed" });
    return structuredClone(result);
  }

  private replay(operationId: string, input: unknown) {
    assertId(operationId, "Operation ID");
    const matching = readJsonl<OperationRecord>(this.operationFile, "operations").filter((item) => item.operationId === operationId);
    if (!matching.length) return null;
    const allLegacy = matching.every((item) => !("schema" in item));
    const allV2 = matching.every((item) => "schema" in item);
    if (!allLegacy && !allV2) throw new OperationInDoubt();
    const inputDigest = allLegacy ? legacyStoreDigest(input) : canonicalStoreDigest(input);
    if (matching.some((item) => item.digest !== inputDigest)) throw new OperationConflict();
    if (allLegacy) {
      const committed = [...matching].reverse().find((item) => item.state === "committed");
      if (!committed?.result) throw new OperationInDoubt();
      return structuredClone(committed.result);
    }
    const records = matching as OperationRecordV2[];
    const reservations = records.filter((record) => record.state === "reserved");
    const committed = records.filter((record) => record.state === "committed");
    if (reservations.length !== 1 || committed.length > 1) throw new OperationInDoubt();
    const reservation = reservations[0];
    if (committed.length) {
      const final = committed[0];
      const { state: _reservedState, ...reservedBody } = reservation;
      const { state: _committedState, ...committedBody } = final;
      if (canonicalStoreDigest(reservedBody) !== canonicalStoreDigest(committedBody)) throw new OperationInDoubt();
      return structuredClone(final.result);
    }
    return this.reconcileReservation(reservation);
  }

  private reconcileReservation(reservation: OperationRecordV2) {
    const state = this.readState();
    const currentDigest = canonicalStoreDigest(state);
    if (currentDigest !== reservation.beforeStateDigest && currentDigest !== reservation.nextStateDigest) throw new OperationInDoubt();
    const matchingDeltas = readJsonl<Delta>(this.deltaFile, "deltas").filter((item) => item.operationId === reservation.operationId);
    if (matchingDeltas.length > 1) throw new OperationInDoubt();
    if (matchingDeltas.length && canonicalStoreDigest(matchingDeltas[0]) !== canonicalStoreDigest(reservation.delta)) throw new OperationInDoubt();
    if (!matchingDeltas.length) appendJsonl(this.deltaFile, reservation.delta);
    if (currentDigest === reservation.beforeStateDigest) writeAtomic(this.stateFile, reservation.nextState);
    if (canonicalStoreDigest(this.readState()) !== reservation.nextStateDigest) throw new OperationInDoubt();
    appendJsonl(this.operationFile, { ...reservation, state: "committed" });
    return structuredClone(reservation.result);
  }

  open(input: OpenWorkInput) {
    return this.locked(() => this.openLocked(input));
  }

  private openLocked(input: OpenWorkInput) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    this.recoverPending();
    assertText(input.topic, "Topic", 160);
    assertText(input.goal, "Goal", 1_000);
    if (input.instruction) assertText(input.instruction, "Instruction", 1_000);
    assertSurface(input.surface);
    const now = this.clock().toISOString();
    const workId = `work:${crypto.randomUUID()}`;
    const branch = input.initialBranch ? this.makeBranch(input.initialBranch, now) : null;
    const work: WorkItem = {
      id: workId,
      topic: input.topic.trim(),
      goal: input.goal.trim(),
      instruction: input.instruction?.trim() ?? null,
      status: "active",
      revision: 1,
      activeBranchId: branch?.id ?? null,
      branches: branch ? [branch] : [],
      openLoops: [],
      nextAction: null,
      lastSurface: structuredClone(input.surface),
      createdAt: now,
      updatedAt: now,
    };
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId,
      revision: 1,
      kind: "open",
      summary: input.goal.trim(),
      surface: structuredClone(input.surface),
      branchId: branch?.id ?? null,
      targetSurface: null,
      provenance: [],
      createdAt: now,
    };
    const state = this.readState();
    const beforeState = structuredClone(state);
    state.work.push(work);
    return this.commit(beforeState, state, delta, input);
  }

  capture(input: CaptureDeltaInput) {
    return this.locked(() => this.captureLocked(input));
  }

  private captureLocked(input: CaptureDeltaInput) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    this.recoverPending();
    assertText(input.summary, "Delta summary", input.kind === "contract_anchor" ? 8_000 : 1_000);
    assertSurface(input.surface);
    const state = this.readState();
    const beforeState = structuredClone(state);
    const index = state.work.findIndex((item) => item.id === input.workId);
    if (index < 0) throw new Error("Work item not found");
    const current = state.work[index];
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current);
    if (["complete", "abandoned"].includes(current.status)) throw new Error("Terminal work cannot accept new deltas");
    if (input.kind === "contract_anchor" && !(input.provenance?.length)) throw new Error("Contract anchors require provenance");
    if (input.kind === "outcome" && (input.openLoops === undefined || !("nextAction" in input) || !(input.provenance?.length))) {
      throw new Error("Outcome requires provenance, openLoops, and nextAction");
    }
    const now = this.clock().toISOString();
    const next = structuredClone(current);
    const revision = current.revision + 1;
    let branchId = input.branchId ?? next.activeBranchId;
    if (input.kind === "branch_open") {
      if (!input.branch) throw new Error("branch_open requires a branch descriptor");
      const branch = this.makeBranch(input.branch, now);
      next.branches.push(branch);
      next.activeBranchId = branch.id;
      branchId = branch.id;
    }
    if (branchId && !next.branches.some((branch) => branch.id === branchId)) throw new Error("Branch not found");
    if (input.kind === "branch_park") {
      if (!branchId) throw new Error("branch_park requires a branch");
      next.branches.find((branch) => branch.id === branchId)!.status = "parked";
      if (next.activeBranchId === branchId) next.activeBranchId = null;
    }
    if (input.kind === "instruction") next.instruction = input.summary.trim();
    if (input.openLoops !== undefined) next.openLoops = [...input.openLoops];
    if ("nextAction" in input) next.nextAction = input.nextAction ?? null;
    if (input.kind === "blocker") next.status = "blocked";
    else if (input.kind === "outcome" || input.kind === "handoff") next.status = "waiting";
    else next.status = "active";
    next.revision = revision;
    next.updatedAt = now;
    next.lastSurface = structuredClone(input.surface);

    const allDeltas = readJsonl<Delta>(this.deltaFile, "deltas");
    const anchors = allDeltas.filter((item) => item.workId === input.workId && item.kind === "contract_anchor");
    const previousAnchor = anchors.at(-1);
    if (input.kind === "contract_anchor" && previousAnchor && !input.provenance?.includes(previousAnchor.id)) {
      throw new Error("A revised contract anchor must cite the previous contract delta ID");
    }
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId: input.workId,
      revision,
      kind: input.kind,
      summary: input.summary.trim(),
      surface: structuredClone(input.surface),
      branchId: branchId ?? null,
      targetSurface: input.targetSurface ?? null,
      provenance: [...(input.provenance ?? [])],
      createdAt: now,
      ...(input.kind === "contract_anchor" ? {
        contractVersion: anchors.length + 1,
        previousContractId: previousAnchor?.id ?? null,
      } : {}),
    };
    state.work[index] = next;
    return this.commit(beforeState, state, delta, input);
  }

  resume(input: { operationId: string; workId: string; expectedRevision: number; surface: Surface; instruction?: string }) {
    return this.locked(() => this.resumeLocked(input));
  }

  private resumeLocked(input: { operationId: string; workId: string; expectedRevision: number; surface: Surface; instruction?: string }) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    this.recoverPending();
    assertSurface(input.surface);
    const state = this.readState();
    const beforeState = structuredClone(state);
    const index = state.work.findIndex((item) => item.id === input.workId);
    if (index < 0) throw new Error("Work item not found");
    const current = state.work[index];
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current);
    if (["complete", "abandoned"].includes(current.status)) throw new Error("Terminal work cannot be resumed");
    const now = this.clock().toISOString();
    const next = structuredClone(current);
    next.revision += 1;
    next.status = "active";
    next.lastSurface = structuredClone(input.surface);
    next.updatedAt = now;
    if (input.instruction) next.instruction = input.instruction.trim();
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId: input.workId,
      revision: next.revision,
      kind: "resume",
      summary: input.instruction?.trim() ?? `Resumed on ${input.surface.kind}:${input.surface.name}`,
      surface: structuredClone(input.surface),
      branchId: next.activeBranchId,
      targetSurface: null,
      provenance: [],
      createdAt: now,
    };
    state.work[index] = next;
    return this.commit(beforeState, state, delta, input);
  }

  /**
   * Close a work item as complete or abandoned (see
   * docs/specs/2026-09-28-core-root-lock-and-close.md §2).
   *
   * The receipt is resolved by reference through the verifier the store was
   * built with and must bind this exact close: work id, expected revision,
   * status and the digest of summary/provenance/status. `complete` refuses
   * work that still has open loops; `abandoned` keeps them as a record of
   * what was dropped. After close the next action is cleared and the work
   * accepts no further capture or resume.
   */
  close(input: CloseWorkInput) {
    // Stage 1 (locked): an already-committed close replays without touching
    // the verifier.
    const done = this.locked(() => this.replay(input.operationId, input));
    if (done) return done;
    // Stage 2 (no lock): resolve the receipt. The verifier may do slow I/O or
    // read Trajecta itself; holding the root lock here would block every
    // writer or re-enter the lock.
    if (!this.resolveReceipt) throw new Error("Closing work needs a receipt verifier; this store has none configured");
    const receipt = this.resolveReceipt(input.verificationRef);
    // Stage 3 (locked): replay again, recover, re-read, CAS, then check the
    // receipt against the exact request at commit time. If the work changed
    // while the receipt was being resolved, CAS fails.
    return this.locked(() => this.closeLocked(input, receipt));
  }

  private closeLocked(input: CloseWorkInput, receipt: unknown) {
    const replay = this.replay(input.operationId, input);
    if (replay) return replay;
    this.recoverPending();
    if (input.status !== "complete" && input.status !== "abandoned") throw new Error("Close status must be complete or abandoned");
    assertText(input.summary, "Close summary", 1_000);
    assertText(input.verificationRef, "Verification reference", 200);
    assertSurface(input.surface);
    if (!Array.isArray(input.provenance) || input.provenance.some((item) => typeof item !== "string")) throw new Error("Close provenance must be a list of references");
    if (input.status === "complete" && !input.provenance.length) throw new Error("Closing as complete requires provenance");
    const state = this.readState();
    const beforeState = structuredClone(state);
    const index = state.work.findIndex((item) => item.id === input.workId);
    if (index < 0) throw new Error("Work item not found");
    const current = state.work[index];
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current);
    if (["complete", "abandoned"].includes(current.status)) throw new Error("Work is already closed");
    if (input.status === "complete" && current.openLoops.length) {
      throw new Error(`Cannot close as complete with ${current.openLoops.length} open loop(s); resolve them first`);
    }
    const now = this.clock();
    assertWorkCloseReceipt(receipt, input, now);
    const next = structuredClone(current);
    next.revision += 1;
    next.status = input.status;
    next.nextAction = null;
    next.lastSurface = structuredClone(input.surface);
    next.updatedAt = now.toISOString();
    const delta: Delta = {
      id: `delta:${crypto.randomUUID()}`,
      operationId: input.operationId,
      workId: input.workId,
      revision: next.revision,
      kind: "close",
      summary: input.summary.trim(),
      surface: structuredClone(input.surface),
      branchId: next.activeBranchId,
      targetSurface: null,
      provenance: [...input.provenance, input.verificationRef],
      createdAt: now.toISOString(),
    };
    state.work[index] = next;
    return this.commit(beforeState, state, delta, input);
  }

  route(cue: string, limit = 3): RouteMatch[] {
    assertText(cue, "Cue", 500);
    const cueTokens = tokenize(cue);
    return this.readState().work
      .filter((item) => !["complete", "abandoned"].includes(item.status))
      .map((item) => {
        const candidates = [item.topic, item.goal, item.instruction ?? "", ...item.branches.flatMap((branch) => [branch.label, branch.purpose, ...branch.cues])];
        const candidateTokens = new Set(candidates.flatMap(tokenize));
        const matchedCues = cueTokens.filter((token) => candidateTokens.has(token));
        const phraseBoost = candidates.some((candidate) => candidate.toLocaleLowerCase().includes(cue.toLocaleLowerCase())) ? 5 : 0;
        return { workId: item.id, topic: item.topic, score: matchedCues.length + phraseBoost, matchedCues, revision: item.revision, updatedAt: item.updatedAt };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  transfer(workId: string, cue: string, intendedFor: "cloud" | "local", maxBytes = 6_000, includeContract = false): TransferPacket {
    if (maxBytes < 900) throw new Error("Transfer budget must be at least 900 bytes");
    const work = this.getWork(workId);
    const activeBranch = work.branches.find((branch) => branch.id === work.activeBranchId) ?? null;
    const deltas = readJsonl<Delta>(this.deltaFile, "deltas").filter((item) => item.workId === workId && item.kind !== "contract_anchor");
    const latestAnchor = includeContract
      ? readJsonl<Delta>(this.deltaFile, "deltas").filter((item) => item.workId === workId && item.kind === "contract_anchor").at(-1)
      : undefined;
    const packetBase = {
      schema: "trajecta.transfer/v1" as const,
      packetId: `packet:${crypto.randomUUID()}`,
      createdAt: this.clock().toISOString(),
      cue,
      from: structuredClone(work.lastSurface),
      intendedFor,
      work: {
        id: work.id,
        topic: work.topic,
        goal: work.goal,
        instruction: work.instruction,
        status: work.status,
        revision: work.revision,
        openLoops: [...work.openLoops],
        nextAction: work.nextAction,
      },
      activeBranch: activeBranch ? structuredClone(activeBranch) : null,
      recentDeltas: [] as TransferPacket["recentDeltas"],
      ...(latestAnchor ? { contractAnchor: {
        id: latestAnchor.id,
        contractVersion: latestAnchor.contractVersion,
        summary: latestAnchor.summary,
        provenance: [...latestAnchor.provenance],
        createdAt: latestAnchor.createdAt,
      }} : {}),
      resume: {
        expectedRevision: work.revision,
        rule: "Resume only this exact work ID with revision compare-and-swap; memory is context, not authority.",
      },
    };
    const selected: TransferPacket["recentDeltas"] = [];
    let truncated = false;
    for (const item of [...deltas].reverse()) {
      const candidate = [{ id: item.id, revision: item.revision, kind: item.kind, summary: item.summary, provenance: [...item.provenance], createdAt: item.createdAt }, ...selected];
      const probe = { ...packetBase, recentDeltas: candidate, budget: { maxBytes, usedBytes: 0, truncated: false } };
      if (Buffer.byteLength(JSON.stringify(probe), "utf8") > maxBytes) {
        truncated = true;
        break;
      }
      selected.unshift(candidate[0]);
    }
    const withoutBudget = { ...packetBase, recentDeltas: selected };
    const budget = { maxBytes, usedBytes: Buffer.byteLength(JSON.stringify(withoutBudget), "utf8"), truncated };
    const packet = { ...withoutBudget, budget };
    packet.budget.usedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
    if (packet.budget.usedBytes > maxBytes) throw new Error("Core work state exceeds the transfer budget");
    return packet;
  }

  getWork(workId: string) {
    const item = this.readState().work.find((candidate) => candidate.id === workId);
    if (!item) throw new Error("Work item not found");
    return structuredClone(item);
  }

  list() {
    return this.readState().work.map((item) => structuredClone(item));
  }

  history(workId: string) {
    this.getWork(workId);
    return readJsonl<Delta>(this.deltaFile, "deltas").filter((item) => item.workId === workId);
  }

  private makeBranch(input: { label: string; purpose: string; cues: string[]; returnPoint: string }, now: string): Branch {
    assertText(input.label, "Branch label", 120);
    assertText(input.purpose, "Branch purpose", 500);
    assertText(input.returnPoint, "Branch return point", 500);
    if (!input.cues?.length) throw new Error("A branch requires at least one cue");
    return { id: `branch:${crypto.randomUUID()}`, label: input.label.trim(), purpose: input.purpose.trim(), cues: [...input.cues], returnPoint: input.returnPoint.trim(), status: "exploring", updatedAt: now };
  }
}
