/**
 * Debug cases and hypotheses (Phase 3 §A,
 * docs/specs/2026-09-29-phase3-cases-skills-claims.md).
 *
 * One domain journal (`cases.jsonl` → `case-index.json`) holds case events
 * and hypothesis events, so one append decides a case and its hypotheses
 * together.
 *
 * - Case status follows an explicit transition table. `resolved` names the
 *   supported hypotheses it rests on (`resolutionHypothesisIds`); at least one
 *   must be agent-attested in this store, so an imported verdict never
 *   resolves a case by itself.
 * - A hypothesis verdict (supported / refuted) is agent-attested: its
 *   `verificationRef` is a typed ref (test: commit: tool: artifact: audit:)
 *   that appears in the matching evidence list. A verdict is final.
 * - The author is the surface the server runs as, never a caller argument.
 * - Hypotheses and cases never become policy; no owner receipt is involved
 *   (Lam's settlement, D1).
 */
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { own } from "./clusters.ts";
import { withRootWriteLock, type LockOptions } from "./lock.ts";
import { INCIDENTS, refs, text } from "./learning.ts";
import type { TrajectaStore } from "./store.ts";
import type { Surface } from "./types.ts";

export const CASE_STATUSES = ["open", "challenged", "resolved", "reopened", "deprioritized"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const HYPOTHESIS_STATUSES = ["hypothesis", "supported", "refuted"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
export type Attestation = "agent" | "imported";

const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["resolved", "challenged", "deprioritized"],
  challenged: ["resolved", "reopened", "deprioritized"],
  resolved: ["reopened", "challenged"],
  reopened: ["resolved", "challenged", "deprioritized"],
  deprioritized: ["reopened"],
};

export const VERIFICATION_REF = /^(test|commit|tool|artifact|audit):[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const CASE_ID = /^case:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const HYPOTHESIS_ID = /^hypothesis:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const SIGNATURE = /^[a-z0-9][a-z0-9_-]{0,119}$/;
function signature(value: unknown) {
  if (typeof value !== "string" || !SIGNATURE.test(value)) throw new Error("signature must be a lowercase slug");
  return value;
}

export interface CaseRecord {
  title: string;
  status: CaseStatus;
  workIds: string[];
  signatures: string[];
  incidentIds: string[];
  resolutionHypothesisIds: string[];
  openedAt: string;
  updatedAt: string;
  attestation: Attestation;
}

export interface HypothesisRecord {
  caseId: string;
  status: HypothesisStatus;
  statement: string;
  signature: string | null;
  supportingRefs: string[];
  disconfirmingRefs: string[];
  discriminatingCheck: string | null;
  verificationRef: string | null;
  attestation: Attestation;
  author: Surface;
  updatedAt: string;
}

export interface CaseIndex {
  cases: Record<string, CaseRecord>;
  hypotheses: Record<string, HypothesisRecord>;
}

type Body =
  | { type: "case_open"; caseId: string; title: string; workIds: string[]; signatures: string[]; evidenceRefs: string[]; attestation: Attestation; surface: Surface; provenance?: string[] }
  | { type: "case_member"; caseId: string; change: "added" | "removed"; incidentId: string; evidenceRefs: string[]; attestation: Attestation; surface: Surface; provenance?: string[] }
  | { type: "case_status"; caseId: string; from: CaseStatus; to: CaseStatus; resolutionHypothesisIds: string[]; evidenceRefs: string[]; attestation: Attestation; surface: Surface; provenance?: string[] }
  | ({ type: "hypothesis"; hypothesisId: string; provenance?: string[] } & Omit<HypothesisRecord, "updatedAt">);

export type CaseEvent = JournalEvent & Body;

export const CASES: DomainSpec<CaseIndex, CaseEvent> = {
  name: "cases",
  projectionFile: "case-index.json",
  projectionSchema: "trajecta.case-index/v1",
  empty: () => ({ cases: {}, hypotheses: {} }),
  apply(index, event) {
    const at = event.recordedAt;
    if (event.type === "case_open") {
      index.cases[event.caseId] = {
        title: event.title, status: "open", workIds: [...event.workIds], signatures: [...event.signatures], incidentIds: [],
        resolutionHypothesisIds: [], openedAt: at, updatedAt: at, attestation: event.attestation,
      };
      return index;
    }
    if (event.type === "hypothesis") {
      const { type: _type, hypothesisId, id: _id, operationId: _op, recordedAt: _at, provenance: _prov, ...record } = event;
      index.hypotheses[hypothesisId] = { ...record, updatedAt: at };
      const parent = own(index.cases, record.caseId);
      if (parent) parent.updatedAt = at;
      return index;
    }
    const record = own(index.cases, event.caseId);
    if (!record) return index;
    if (event.type === "case_member") {
      record.incidentIds = event.change === "added" ? [...record.incidentIds, event.incidentId] : record.incidentIds.filter((id) => id !== event.incidentId);
    } else {
      record.status = event.to;
      record.resolutionHypothesisIds = event.to === "resolved" ? [...event.resolutionHypothesisIds] : [];
    }
    record.updatedAt = at;
    return index;
  },
  isEvent: (value: unknown): value is CaseEvent => {
    const event = value as Partial<CaseEvent> | null;
    if (!event || typeof event.id !== "string") return false;
    if (event.type === "hypothesis") return typeof (event as { hypothesisId?: unknown }).hypothesisId === "string" && HYPOTHESIS_STATUSES.includes((event as { status: HypothesisStatus }).status);
    return ["case_open", "case_member", "case_status"].includes(event.type as string) && typeof (event as { caseId?: unknown }).caseId === "string";
  },
};

function caseId(value: unknown) {
  if (typeof value !== "string" || !CASE_ID.test(value)) throw new Error("case_id must look like case:some-id");
  return value;
}

function hypothesisId(value: unknown) {
  if (typeof value !== "string" || !HYPOTHESIS_ID.test(value)) throw new Error("hypothesis_id must look like hypothesis:some-id");
  return value;
}

function evidence(value: unknown, label = "evidence_refs") {
  const list = refs(value, label);
  if (!list.length) throw new Error(`${label} needs at least one reference`);
  return list;
}

export interface CaseEventInput {
  caseId: string;
  eventType: "open" | "member_added" | "member_removed" | "status";
  title?: string;
  workIds?: string[];
  signatures?: string[];
  incidentId?: string;
  status?: CaseStatus;
  resolutionHypothesisIds?: string[];
  evidenceRefs: string[];
  surface: Surface;
  /** Import only: history from another store. Never set over MCP. */
  imported?: { provenance: string[] };
}

export interface HypothesisInput {
  hypothesisId: string;
  caseId: string;
  status: HypothesisStatus;
  statement: string;
  signature?: string | null;
  supportingRefs?: string[];
  disconfirmingRefs?: string[];
  discriminatingCheck?: string | null;
  verificationRef?: string | null;
  surface: Surface;
  imported?: { provenance: string[] };
}

export class CaseLayer {
  readonly journal: DomainJournal<CaseIndex, CaseEvent>;
  private readonly incidents;
  private readonly store: TrajectaStore;
  private readonly lock?: LockOptions;

  constructor(store: TrajectaStore, options: { clock?: () => Date; lock?: LockOptions } = {}) {
    this.store = store;
    this.lock = options.lock;
    this.journal = new DomainJournal(store.root, CASES, options.clock, undefined, options.lock);
    this.incidents = new DomainJournal(store.root, INCIDENTS, options.clock, undefined, options.lock);
  }

  /** Open a case, change its incident members, or move its status. */
  recordCaseEvent(operationId: string, input: CaseEventInput) {
    const id = caseId(input.caseId);
    const attestation: Attestation = input.imported ? "imported" : "agent";
    const provenance = input.imported ? { provenance: refs(input.imported.provenance, "provenance") } : {};
    const evidenceRefs = input.imported ? refs(input.evidenceRefs, "evidence_refs") : evidence(input.evidenceRefs);
    // A status event's `from` is filled in under the lock, from the current case.
    let body: Exclude<Body, { type: "case_status" | "hypothesis" }> | Omit<Extract<Body, { type: "case_status" }>, "from">;
    if (input.eventType === "open") {
      if (input.incidentId !== undefined || input.status !== undefined) throw new Error("open takes a title and work ids only");
      const workIds = [...new Set(input.workIds ?? [])];
      if (!workIds.length || workIds.length > 20) throw new Error("open needs 1..20 work ids");
      for (const workId of workIds) this.store.getWork(workId);
      const signatures = [...new Set(input.signatures ?? [])].map(signature);
      body = { type: "case_open", caseId: id, title: text(input.title, "title", 200), workIds, signatures, evidenceRefs, attestation, surface: input.surface, ...provenance };
    } else if (input.eventType === "member_added" || input.eventType === "member_removed") {
      if (typeof input.incidentId !== "string") throw new Error(`${input.eventType} needs an incident_id`);
      body = { type: "case_member", caseId: id, change: input.eventType === "member_added" ? "added" : "removed", incidentId: input.incidentId, evidenceRefs, attestation, surface: input.surface, ...provenance };
    } else if (input.eventType === "status") {
      if (!CASE_STATUSES.includes(input.status as CaseStatus)) throw new Error(`status must be one of ${CASE_STATUSES.join(", ")}`);
      const resolution = [...new Set(input.resolutionHypothesisIds ?? [])].map(hypothesisId);
      if (input.status !== "resolved" && resolution.length) throw new Error("resolution_hypothesis_ids apply only to resolved");
      body = { type: "case_status", caseId: id, to: input.status as CaseStatus, resolutionHypothesisIds: resolution, evidenceRefs, attestation, surface: input.surface, ...provenance };
    } else {
      throw new Error("event_type must be open, member_added, member_removed or status");
    }
    const request = body;
    return withRootWriteLock(this.store.root, () => {
      const replayed = this.journal.replayHeld(operationId, request);
      if (replayed) return { ...replayed, replayed: true };
      const knownIncidents = body.type === "case_member" ? this.incidents.readHeld().byId : null;
      return { ...this.journal.appendHeld(operationId, request, (index) => {
        const existing = own(index.cases, id);
        if (body.type === "case_open") {
          if (existing) throw new Error(`Case ${id} already exists`);
          return body as Body;
        }
        if (!existing) throw new Error(`Case ${id} not found`);
        if (body.type === "case_member") {
          if (!own(knownIncidents!, body.incidentId)) throw new Error("Incident not found");
          const member = existing.incidentIds.includes(body.incidentId);
          if (body.change === "added" && member) throw new Error("Incident is already in this case");
          if (body.change === "removed" && !member) throw new Error("Incident is not in this case");
          return body as Body;
        }
        const next = body.to;
        if (attestation === "agent" && !TRANSITIONS[existing.status].includes(next)) {
          throw new Error(`A case cannot go from ${existing.status} to ${next}`);
        }
        if (attestation === "agent" && next === "resolved") {
          if (!body.resolutionHypothesisIds.length) throw new Error("resolved needs resolution_hypothesis_ids: the supported hypotheses it rests on");
          const basis = body.resolutionHypothesisIds.map((hid) => {
            const hypothesis = own(index.hypotheses, hid);
            if (!hypothesis || hypothesis.caseId !== id) throw new Error(`${hid} is not a hypothesis of ${id}`);
            if (hypothesis.status !== "supported") throw new Error(`${hid} is ${hypothesis.status}, not supported`);
            return hypothesis;
          });
          if (!basis.some((hypothesis) => hypothesis.attestation === "agent")) {
            throw new Error("A local resolution needs at least one supported hypothesis attested in this store; imported support is history only");
          }
        }
        return { ...body, from: existing.status };
      }), replayed: false };
    }, this.lock);
  }

  /** Propose a hypothesis, update its refs, or record its (final) verdict. */
  recordHypothesis(operationId: string, input: HypothesisInput) {
    const imported = Boolean(input.imported);
    const status = input.status;
    if (!HYPOTHESIS_STATUSES.includes(status)) throw new Error(`status must be one of ${HYPOTHESIS_STATUSES.join(", ")}`);
    const supportingRefs = refs(input.supportingRefs, "supporting_refs");
    const disconfirmingRefs = refs(input.disconfirmingRefs, "disconfirming_refs");
    const verificationRef = typeof input.verificationRef === "string" && input.verificationRef.length <= 200 ? input.verificationRef : null;
    if (!imported && input.verificationRef != null && verificationRef === null) throw new Error("verification_ref must be a reference string");
    if (!imported) {
      if (status === "hypothesis" && verificationRef) throw new Error("An open hypothesis carries no verification_ref");
      if (status !== "hypothesis") {
        if (typeof verificationRef !== "string" || !VERIFICATION_REF.test(verificationRef)) {
          throw new Error("A verdict needs verification_ref: a test:, commit:, tool:, artifact: or audit: reference");
        }
        const matching = status === "supported" ? supportingRefs : disconfirmingRefs;
        if (!matching.includes(verificationRef)) throw new Error(`verification_ref must appear in ${status === "supported" ? "supporting_refs" : "disconfirming_refs"}`);
      }
    }
    const body: Body = {
      type: "hypothesis",
      hypothesisId: hypothesisId(input.hypothesisId),
      caseId: caseId(input.caseId),
      status,
      statement: text(input.statement, "statement", 1_000),
      signature: input.signature ? signature(input.signature) : null,
      supportingRefs,
      disconfirmingRefs,
      discriminatingCheck: input.discriminatingCheck ? text(input.discriminatingCheck, "discriminating_check", 1_000) : null,
      verificationRef,
      attestation: imported ? "imported" : "agent",
      author: input.surface,
      ...(input.imported ? { provenance: refs(input.imported.provenance, "provenance") } : {}),
    };
    return withRootWriteLock(this.store.root, () => {
      const replayed = this.journal.replayHeld(operationId, body);
      if (replayed) return { ...replayed, replayed: true };
      return { ...this.journal.appendHeld(operationId, body, (index) => {
        if (!own(index.cases, body.caseId)) throw new Error(`Case ${body.caseId} not found`);
        const prior = own(index.hypotheses, body.hypothesisId);
        if (prior) {
          if (prior.caseId !== body.caseId || prior.statement !== body.statement || prior.signature !== body.signature) {
            throw new Error("A hypothesis keeps its case, statement and signature; state a new idea as a new hypothesis");
          }
          if (prior.status !== "hypothesis") throw new Error(`${body.hypothesisId} is already ${prior.status}; a verdict is final`);
        }
        return body;
      }), replayed: false };
    }, this.lock);
  }

  getCase(id: string, mode: "normal" | "debug" | "audit" = "normal") {
    const index = this.journal.read();
    const record = own(index.cases, caseId(id));
    if (!record) throw new Error(`Case ${id} not found`);
    const hypotheses = Object.entries(index.hypotheses).filter(([, item]) => item.caseId === id);
    return {
      case_id: id, ...compactCase(record),
      hypotheses: hypotheses.map(([hid, item]) => ({
        id: hid, status: item.status, statement: item.statement, attestation: item.attestation,
        ...(mode === "normal" ? {} : { verification_ref: item.verificationRef, supporting_refs: item.supportingRefs, disconfirming_refs: item.disconfirmingRefs, discriminating_check: item.discriminatingCheck }),
      })),
      ...(mode === "audit" ? { events: this.journal.events().filter((event) => ("caseId" in event ? event.caseId : null) === id).slice(-50) } : {}),
    };
  }

  /** Cases that touch a work item, most recently updated last. */
  linkedCases(workId: string, limit = 5) {
    return Object.entries(this.journal.read().cases)
      .filter(([, record]) => record.workIds.includes(workId))
      .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(-limit);
  }

  hypothesesOf(id: string) {
    return Object.entries(this.journal.read().hypotheses).filter(([, item]) => item.caseId === id);
  }
}

export function compactCase(record: CaseRecord) {
  return {
    title: record.title, status: record.status, work_ids: record.workIds, incident_ids: record.incidentIds,
    resolution_hypothesis_ids: record.resolutionHypothesisIds, attestation: record.attestation, updated_at: record.updatedAt,
  };
}
