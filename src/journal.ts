/**
 * Domain journals: append-only records that live beside the work store.
 *
 * Clusters, capability snapshots, incidents, chronicle and skills each keep
 * their own journal and rebuildable projection (decision 1 in
 * docs/specs/2026-09-28-work-layers-from-awm.md). They never touch
 * `state.json` or work item revisions.
 *
 * Every write follows the store's durability discipline:
 *
 *   reserve (domain-operations.jsonl) → append journal → write projection
 *   → commit (domain-operations.jsonl)
 *
 * The reservation carries the event and the next projection, so an
 * interrupted write is finished on the next call with the same operation id.
 * Reusing an operation id with different input is rejected. All domains share
 * one operation ledger; each record names its domain.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, canonicalStoreDigest, OperationConflict, OperationInDoubt, writeAtomic } from "./store.ts";
import { withRootWriteLock, type LockOptions } from "./lock.ts";

export type JournalFaultPoint = "after-reserve" | "after-journal" | "after-projection";

export const LEDGER_FILE = "domain-operations.jsonl";

export interface JournalEvent {
  id: string;
  operationId: string;
  recordedAt: string;
}

export interface DomainSpec<P, E extends JournalEvent> {
  /** Journal file stem, e.g. `cluster-membership` → cluster-membership.jsonl. */
  name: string;
  /** Projection file name, e.g. `cluster-index.json`. */
  projectionFile: string;
  /** Schema id written into the projection file. */
  projectionSchema: string;
  empty(): P;
  apply(projection: P, event: E): P;
  isEvent(value: unknown): value is E;
}

interface ProjectionFile<P> {
  schema: string;
  events: number;
  value: P;
}

interface LedgerRecord<P, E> {
  schema: "trajecta.domain-operation/v1";
  domain: string;
  operationId: string;
  digest: string;
  state: "reserved" | "committed";
  beforeProjectionDigest: string;
  nextProjectionDigest: string;
  event: E;
  nextProjection: ProjectionFile<P>;
}

function assertOperationId(value: string) {
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value ?? "")) throw new Error("Operation ID must be a namespaced opaque ID");
}

function readLines(file: string): unknown[] {
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
    return content.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  } catch {
    throw new OperationInDoubt();
  }
}

function isLedgerRecord(value: unknown): value is LedgerRecord<unknown, JournalEvent> {
  const record = value as Partial<LedgerRecord<unknown, JournalEvent>> | null;
  return Boolean(record)
    && record!.schema === "trajecta.domain-operation/v1"
    && typeof record!.domain === "string"
    && typeof record!.operationId === "string"
    && typeof record!.digest === "string"
    && (record!.state === "reserved" || record!.state === "committed")
    && typeof record!.beforeProjectionDigest === "string"
    && typeof record!.nextProjectionDigest === "string"
    && Boolean(record!.event)
    && Boolean(record!.nextProjection);
}

export class DomainJournal<P, E extends JournalEvent> {
  readonly root: string;
  readonly spec: DomainSpec<P, E>;
  private readonly journalFile: string;
  private readonly projectionPath: string;
  private readonly ledgerFile: string;
  private readonly clock: () => Date;
  private readonly fault?: (point: JournalFaultPoint) => void;

  private readonly lockOptions: LockOptions;

  constructor(root: string, spec: DomainSpec<P, E>, clock: () => Date = () => new Date(), fault?: (point: JournalFaultPoint) => void, lockOptions: LockOptions = {}) {
    this.lockOptions = lockOptions;
    this.root = root;
    this.spec = spec;
    this.journalFile = path.join(root, `${spec.name}.jsonl`);
    this.projectionPath = path.join(root, spec.projectionFile);
    this.ledgerFile = path.join(root, LEDGER_FILE);
    this.clock = clock;
    this.fault = fault;
  }

  now() {
    return this.clock();
  }

  events(): E[] {
    return readLines(this.journalFile).map((value) => {
      if (!this.spec.isEvent(value)) throw new OperationInDoubt();
      return value;
    });
  }

  private readProjectionFile(): ProjectionFile<P> {
    if (!fs.existsSync(this.projectionPath)) return { schema: this.spec.projectionSchema, events: 0, value: this.spec.empty() };
    try {
      const value = JSON.parse(fs.readFileSync(this.projectionPath, "utf8")) as ProjectionFile<P>;
      if (value?.schema !== this.spec.projectionSchema || !Number.isInteger(value.events) || value.value === undefined) throw new OperationInDoubt();
      return value;
    } catch (error) {
      if (error instanceof OperationInDoubt) throw error;
      throw new OperationInDoubt();
    }
  }

  read(): P {
    return structuredClone(this.readProjectionFile().value);
  }

  /** Fold the journal from scratch; must equal the stored projection. */
  rebuild(): P {
    return this.events().reduce((projection, event) => this.spec.apply(projection, event), this.spec.empty());
  }

  /** Journal and projection agree. Takes the root lock so no writer is mid-commit. */
  verify() {
    return withRootWriteLock(this.root, () => this.verifyLocked(), this.lockOptions);
  }

  private verifyLocked() {
    const stored = this.readProjectionFile();
    const events = this.events();
    return stored.events === events.length && canonicalStoreDigest(stored.value) === canonicalStoreDigest(this.rebuild());
  }

  /**
   * Append one event. `build` receives the current projection and returns the
   * event body (id, operationId and recordedAt are filled in). It may throw
   * to reject the write; nothing is recorded then.
   */
  append(operationId: string, input: unknown, build: (projection: P, now: string) => Omit<E, keyof JournalEvent>): { event: E; projection: P; replayed: boolean } {
    assertOperationId(operationId);
    return withRootWriteLock(this.root, () => this.appendLocked(operationId, input, build), this.lockOptions);
  }

  private appendLocked(operationId: string, input: unknown, build: (projection: P, now: string) => Omit<E, keyof JournalEvent>): { event: E; projection: P; replayed: boolean } {
    const replayed = this.replay(operationId, input);
    if (replayed) return { ...replayed, replayed: true };
    this.recoverPending();
    const before = this.readProjectionFile();
    const now = this.clock().toISOString();
    const body = build(structuredClone(before.value), now);
    const event = { ...body, id: `event:${crypto.randomUUID()}`, operationId, recordedAt: now } as E;
    if (!this.spec.isEvent(event)) throw new Error(`Invalid ${this.spec.name} event`);
    const next: ProjectionFile<P> = {
      schema: this.spec.projectionSchema,
      events: before.events + 1,
      value: this.spec.apply(structuredClone(before.value), event),
    };
    const reservation: LedgerRecord<P, E> = {
      schema: "trajecta.domain-operation/v1",
      domain: this.spec.name,
      operationId,
      digest: canonicalStoreDigest(input),
      state: "reserved",
      beforeProjectionDigest: canonicalStoreDigest(before),
      nextProjectionDigest: canonicalStoreDigest(next),
      event,
      nextProjection: next,
    };
    appendJsonl(this.ledgerFile, reservation);
    this.fault?.("after-reserve");
    appendJsonl(this.journalFile, event);
    this.fault?.("after-journal");
    writeAtomic(this.projectionPath, next);
    this.fault?.("after-projection");
    appendJsonl(this.ledgerFile, { ...reservation, state: "committed" });
    return { event: structuredClone(event), projection: structuredClone(next.value), replayed: false };
  }

  private ledger() {
    return readLines(this.ledgerFile).map((value) => {
      if (!isLedgerRecord(value)) throw new OperationInDoubt();
      return value;
    }) as LedgerRecord<P, E>[];
  }

  /**
   * Finish any write of this domain that was interrupted after its
   * reservation, before a new write builds on the projection. Without this a
   * crash between "append journal" and "write projection" followed by an
   * unrelated write would leave the journal and projection disagreeing.
   */
  private recoverPending() {
    const records = this.ledger().filter((record) => record.domain === this.spec.name);
    const committed = new Set(records.filter((record) => record.state === "committed").map((record) => record.operationId));
    for (const reservation of records.filter((record) => record.state === "reserved" && !committed.has(record.operationId))) {
      this.reconcile(reservation);
    }
  }

  private replay(operationId: string, input: unknown): { event: E; projection: P } | null {
    const matching = this.ledger().filter((record) => record.operationId === operationId);
    if (!matching.length) return null;
    if (matching.some((record) => record.domain !== this.spec.name)) throw new OperationConflict();
    if (matching.some((record) => record.digest !== canonicalStoreDigest(input))) throw new OperationConflict();
    const reservations = matching.filter((record) => record.state === "reserved");
    const committed = matching.filter((record) => record.state === "committed");
    if (reservations.length !== 1 || committed.length > 1) throw new OperationInDoubt();
    const reservation = reservations[0];
    if (committed.length) {
      const { state: _a, ...reservedBody } = reservation;
      const { state: _b, ...committedBody } = committed[0];
      if (canonicalStoreDigest(reservedBody) !== canonicalStoreDigest(committedBody)) throw new OperationInDoubt();
      return { event: structuredClone(reservation.event), projection: structuredClone(reservation.nextProjection.value) };
    }
    return this.reconcile(reservation);
  }

  private reconcile(reservation: LedgerRecord<P, E>) {
    const current = canonicalStoreDigest(this.readProjectionFile());
    if (current !== reservation.beforeProjectionDigest && current !== reservation.nextProjectionDigest) throw new OperationInDoubt();
    const matching = this.events().filter((event) => event.operationId === reservation.operationId);
    if (matching.length > 1) throw new OperationInDoubt();
    if (matching.length && canonicalStoreDigest(matching[0]) !== canonicalStoreDigest(reservation.event)) throw new OperationInDoubt();
    if (!matching.length) appendJsonl(this.journalFile, reservation.event);
    if (current === reservation.beforeProjectionDigest) writeAtomic(this.projectionPath, reservation.nextProjection);
    if (canonicalStoreDigest(this.readProjectionFile()) !== reservation.nextProjectionDigest) throw new OperationInDoubt();
    appendJsonl(this.ledgerFile, { ...reservation, state: "committed" });
    return { event: structuredClone(reservation.event), projection: structuredClone(reservation.nextProjection.value) };
  }
}
