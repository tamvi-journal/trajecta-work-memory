/**
 * The learning loop (Phase 2 of docs/specs/2026-09-28-work-layers-from-awm.md).
 *
 * - Incident: an agent broke a rule, chose the wrong rail, lost the goal.
 *   Incidents with the same (cluster, kind, violated invariant) form a group.
 *   The tier counts distinct evidence sets in the group:
 *   1 → raw, 2 → repeated, 3+ → learning_candidate. Recording the same
 *   evidence again never raises the tier.
 * - Friction: a tool or system was hard to use. Same tiers, by occurrence.
 * - Chronicle: bounded milestones of one work item (goal → … → next_action),
 *   never a transcript.
 * - Invariant: an accepted prevention rule. Only a learning_candidate can be
 *   promoted, only with an owner-approval receipt bound to that incident and
 *   that exact rule, and only once. No autonomous promotion.
 * - check_action: before a consequential action, returns the profile's guards
 *   that block it and the accepted invariants for the cluster. Candidates and
 *   raw incidents are never policy.
 *
 * Each of these is its own domain journal on the shared operation ledger.
 */
import crypto from "node:crypto";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { CLUSTER_ID, own } from "./clusters.ts";
import { holdsRootWriteLock, withRootWriteLock, type LockOptions } from "./lock.ts";
import { assertOwnerApproval, invariantDigest } from "./receipts.ts";
import type { TrajectaStore } from "./store.ts";
import type { Surface } from "./types.ts";

export type Tier = "raw" | "repeated" | "learning_candidate";
const tierFor = (count: number): Tier => (count <= 1 ? "raw" : count === 2 ? "repeated" : "learning_candidate");

const REF = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value.trim();
}

export function refs(value: unknown, label: string, max = 20) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.length > 200 || !REF.test(item))) {
    throw new Error(`${label} must be up to ${max} references like kind:id`);
  }
  return [...new Set(value as string[])];
}

export function slug(value: unknown, label: string) {
  if (typeof value !== "string" || !SLUG.test(value)) throw new Error(`${label} must be a short lowercase slug`);
  return value;
}

export function cluster(value: unknown) {
  if (typeof value !== "string" || !CLUSTER_ID.test(value)) throw new Error("cluster must be a cluster id");
  return value;
}

function groupKey(...parts: string[]) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

// --- incidents ---------------------------------------------------------------

export interface Incident extends JournalEvent {
  type: "incident";
  workId: string | null;
  cluster: string;
  kind: string;
  summary: string;
  violatedInvariant: string;
  evidenceRefs: string[];
  correction: string;
  preventionRule: string;
  rootCause: string | null;
  /** Where this record came from (e.g. an import). Never counted as evidence. */
  provenance: string[];
  surface: Surface;
  groupKey: string;
  occurrence: number;
  learningEvidenceCount: number;
  tier: Tier;
}

export interface IncidentIndex {
  byId: Record<string, Pick<Incident, "workId" | "cluster" | "kind" | "summary" | "violatedInvariant" | "preventionRule" | "correction" | "tier" | "groupKey" | "recordedAt">>;
  groups: Record<string, { occurrences: number; evidenceSets: string[]; ids: string[] }>;
}

export const INCIDENTS: DomainSpec<IncidentIndex, Incident> = {
  name: "incidents",
  projectionFile: "incident-index.json",
  projectionSchema: "trajecta.incident-index/v1",
  empty: () => ({ byId: {}, groups: {} }),
  apply(index, event) {
    const { workId, cluster: c, kind, summary, violatedInvariant, preventionRule, correction, tier, groupKey: key, recordedAt } = event;
    index.byId[event.id] = { workId, cluster: c, kind, summary, violatedInvariant, preventionRule, correction, tier, groupKey: key, recordedAt };
    const group = own(index.groups, key) ?? { occurrences: 0, evidenceSets: [], ids: [] };
    const evidenceSet = JSON.stringify([...event.evidenceRefs].sort());
    group.occurrences += 1;
    if (!group.evidenceSets.includes(evidenceSet)) group.evidenceSets.push(evidenceSet);
    group.ids.push(event.id);
    index.groups[key] = group;
    return index;
  },
  isEvent: (value: unknown): value is Incident => {
    const event = value as Partial<Incident> | null;
    return Boolean(event) && event!.type === "incident" && typeof event!.id === "string" && typeof event!.groupKey === "string"
      && Array.isArray(event!.evidenceRefs) && ["raw", "repeated", "learning_candidate"].includes(event!.tier as string);
  },
};

// --- friction ----------------------------------------------------------------

export interface Friction extends JournalEvent {
  type: "friction";
  workId: string | null;
  cluster: string;
  component: string;
  kind: string;
  summary: string;
  surface: Surface;
  groupKey: string;
  occurrence: number;
  tier: Tier;
  /** Where the record came from (e.g. `source:awm:<id>` on import). Never counted. */
  provenance?: string[];
}

export const FRICTION: DomainSpec<{ groups: Record<string, number> }, Friction> = {
  name: "friction",
  projectionFile: "friction-index.json",
  projectionSchema: "trajecta.friction-index/v1",
  empty: () => ({ groups: {} }),
  apply(index, event) {
    index.groups[event.groupKey] = (own(index.groups, event.groupKey) ?? 0) + 1;
    return index;
  },
  isEvent: (value: unknown): value is Friction => {
    const event = value as Partial<Friction> | null;
    return Boolean(event) && event!.type === "friction" && typeof event!.id === "string" && typeof event!.groupKey === "string";
  },
};

// --- chronicle -----------------------------------------------------------------

export const CHRONICLE_STAGES = ["goal", "decision", "rail", "action", "outcome", "blocker", "correction", "next_action"] as const;
export type ChronicleStage = (typeof CHRONICLE_STAGES)[number];

export interface Milestone extends JournalEvent {
  type: "milestone";
  workId: string;
  cluster: string | null;
  stage: ChronicleStage;
  summary: string;
  provenance: string[];
  surface: Surface;
}

export const CHRONICLE: DomainSpec<{ byWork: Record<string, number> }, Milestone> = {
  name: "chronicle",
  projectionFile: "chronicle-index.json",
  projectionSchema: "trajecta.chronicle-index/v1",
  empty: () => ({ byWork: {} }),
  apply(index, event) {
    index.byWork[event.workId] = (own(index.byWork, event.workId) ?? 0) + 1;
    return index;
  },
  isEvent: (value: unknown): value is Milestone => {
    const event = value as Partial<Milestone> | null;
    return Boolean(event) && event!.type === "milestone" && typeof event!.workId === "string"
      && (CHRONICLE_STAGES as readonly string[]).includes(event!.stage as string);
  },
};

// --- invariants -------------------------------------------------------------------

export interface InvariantAccepted extends JournalEvent {
  type: "accepted";
  invariantId: string;
  cluster: string;
  rule: string;
  violatedInvariant: string;
  sourceIncidentId: string;
  approvalRef: string;
  surface: Surface;
}

export interface Invariant {
  invariantId: string;
  cluster: string;
  rule: string;
  violatedInvariant: string;
  sourceIncidentId: string;
  approvalRef: string;
  acceptedAt: string;
  status: "active";
}

export interface InvariantIndex {
  byId: Record<string, Invariant>;
  bySourceIncident: Record<string, string>;
}

export const INVARIANTS: DomainSpec<InvariantIndex, InvariantAccepted> = {
  name: "invariants",
  projectionFile: "invariant-index.json",
  projectionSchema: "trajecta.invariant-index/v1",
  empty: () => ({ byId: {}, bySourceIncident: {} }),
  apply(index, event) {
    index.byId[event.invariantId] = {
      invariantId: event.invariantId, cluster: event.cluster, rule: event.rule, violatedInvariant: event.violatedInvariant,
      sourceIncidentId: event.sourceIncidentId, approvalRef: event.approvalRef, acceptedAt: event.recordedAt, status: "active",
    };
    index.bySourceIncident[event.sourceIncidentId] = event.invariantId;
    return index;
  },
  isEvent: (value: unknown): value is InvariantAccepted => {
    const event = value as Partial<InvariantAccepted> | null;
    return Boolean(event) && event!.type === "accepted" && typeof event!.invariantId === "string" && typeof event!.sourceIncidentId === "string";
  },
};

// --- guards ---------------------------------------------------------------------

/**
 * Deterministic pre-action guards. A profile opts into them by id; none is on
 * by default. They are product rules the owner chose, not learned policy.
 */
export const GUARDS = {
  "observable-no-headless": {
    description: "When the owner asked for an observable surface, a headless substitute is not allowed.",
    blocks: (input: CheckActionInput) => input.requestedSurface === "observable" && /headless/i.test(input.actionSummary),
  },
  "identity-proof-before-mutation": {
    description: "Acting on a target named by a human needs proof that it is that exact target.",
    blocks: (input: CheckActionInput) => Boolean(input.targetName) && !input.semanticIdentityProof,
  },
  "reanchor-after-repeats": {
    description: "Three or more attempts without a progress marker: re-anchor the objective and the done condition first.",
    blocks: (input: CheckActionInput) => (input.repeatedAttempts ?? 0) >= 3 && !input.progressMarker,
  },
} as const;
export type GuardId = keyof typeof GUARDS;
export const GUARD_IDS = Object.keys(GUARDS) as GuardId[];

export interface CheckActionInput {
  cluster: string;
  actionSummary: string;
  requestedSurface?: string;
  targetName?: string;
  semanticIdentityProof?: string;
  repeatedAttempts?: number;
  progressMarker?: string;
}

// --- layer ------------------------------------------------------------------------

export interface LearningOptions {
  clock?: () => Date;
  resolveReceipt?: (reference: string) => unknown;
  lock?: LockOptions;
  guards?: GuardId[];
}

export class LearningLayer {
  readonly root: string;
  readonly incidents: DomainJournal<IncidentIndex, Incident>;
  readonly friction: DomainJournal<{ groups: Record<string, number> }, Friction>;
  readonly chronicle: DomainJournal<{ byWork: Record<string, number> }, Milestone>;
  readonly invariants: DomainJournal<InvariantIndex, InvariantAccepted>;
  private readonly store: TrajectaStore;
  private readonly options: LearningOptions;

  constructor(store: TrajectaStore, options: LearningOptions = {}) {
    this.store = store;
    this.root = store.root;
    this.options = options;
    const clock = options.clock;
    this.incidents = new DomainJournal(this.root, INCIDENTS, clock, undefined, options.lock);
    this.friction = new DomainJournal(this.root, FRICTION, clock, undefined, options.lock);
    this.chronicle = new DomainJournal(this.root, CHRONICLE, clock, undefined, options.lock);
    this.invariants = new DomainJournal(this.root, INVARIANTS, clock, undefined, options.lock);
    for (const guard of options.guards ?? []) if (!Object.hasOwn(GUARDS, guard)) throw new Error(`Unknown guard ${guard}`);
  }

  private workOrNull(workId: unknown) {
    if (workId === undefined || workId === null) return null;
    if (typeof workId !== "string") throw new Error("work_id must be a string");
    return this.store.getWork(workId).id;
  }

  recordIncident(operationId: string, input: {
    workId?: string | null; cluster: string; kind: string; summary: string; violatedInvariant: string;
    evidenceRefs: string[]; correction: string; preventionRule: string; rootCause?: string | null; surface: Surface;
    provenance?: string[];
  }) {
    const body = {
      workId: this.workOrNull(input.workId),
      cluster: cluster(input.cluster),
      kind: slug(input.kind, "kind"),
      summary: text(input.summary, "summary", 1_000),
      violatedInvariant: text(input.violatedInvariant, "violated_invariant", 500),
      evidenceRefs: refs(input.evidenceRefs, "evidence_refs"),
      correction: text(input.correction, "correction", 1_000),
      preventionRule: text(input.preventionRule, "prevention_rule", 1_000),
      rootCause: input.rootCause ? text(input.rootCause, "root_cause", 300) : null,
      provenance: refs(input.provenance, "provenance"),
      surface: input.surface,
    };
    if (!body.evidenceRefs.length) throw new Error("An incident needs at least one evidence reference");
    return this.incidents.append(operationId, body, (index) => {
      const key = groupKey(body.cluster, body.kind, body.violatedInvariant);
      const group = own(index.groups, key) ?? { occurrences: 0, evidenceSets: [], ids: [] };
      const evidenceSet = JSON.stringify([...body.evidenceRefs].sort());
      const learningEvidenceCount = group.evidenceSets.length + (group.evidenceSets.includes(evidenceSet) ? 0 : 1);
      return { type: "incident" as const, ...body, groupKey: key, occurrence: group.occurrences + 1, learningEvidenceCount, tier: tierFor(learningEvidenceCount) };
    });
  }

  recordFriction(operationId: string, input: { workId?: string | null; cluster: string; component: string; kind: string; summary: string; provenance?: string[]; surface: Surface }) {
    const provenance = refs(input.provenance, "provenance");
    const body = {
      workId: this.workOrNull(input.workId),
      cluster: cluster(input.cluster),
      component: slug(input.component, "component"),
      kind: slug(input.kind, "kind"),
      summary: text(input.summary, "summary", 1_000),
      surface: input.surface,
      // Only present when given, so friction recorded before this field existed replays unchanged.
      ...(provenance.length ? { provenance } : {}),
    };
    return this.friction.append(operationId, body, (index) => {
      const key = groupKey(body.cluster, body.component, body.kind);
      const occurrence = (own(index.groups, key) ?? 0) + 1;
      return { type: "friction" as const, ...body, groupKey: key, occurrence, tier: tierFor(occurrence) };
    });
  }

  recordMilestone(operationId: string, input: { workId: string; cluster?: string | null; stage: ChronicleStage; summary: string; provenance?: string[]; surface: Surface }) {
    const body = {
      workId: this.store.getWork(text(input.workId, "work_id", 200)).id,
      cluster: input.cluster ? cluster(input.cluster) : null,
      stage: (CHRONICLE_STAGES as readonly string[]).includes(input.stage) ? input.stage : (() => { throw new Error(`stage must be one of ${CHRONICLE_STAGES.join(", ")}`); })(),
      summary: text(input.summary, "summary", 1_000),
      provenance: refs(input.provenance, "provenance"),
      surface: input.surface,
    };
    return this.chronicle.append(operationId, body, () => ({ type: "milestone" as const, ...body }));
  }

  /**
   * Promote a learning_candidate incident into an accepted invariant.
   * Three stages, like store.close: locked replay → pure validation →
   * unlocked receipt resolution → locked re-check and commit.
   */
  promoteIncident(operationId: string, input: { incidentId: string; approvalRef: string; surface: Surface }) {
    const request = { incidentId: input.incidentId, approvalRef: input.approvalRef };
    const done = withRootWriteLock(this.root, () => this.invariants.replayHeld(operationId, request), this.options.lock);
    if (done) return { ...done, replayed: true };
    if (typeof input.incidentId !== "string" || !/^event:[A-Za-z0-9-]+$/.test(input.incidentId)) throw new Error("incident_id must be an incident event id");
    if (typeof input.approvalRef !== "string" || !/^receipt:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.approvalRef)) throw new Error("approval_ref must be a receipt reference");
    if (!this.options.resolveReceipt) throw new Error("Promoting needs a receipt verifier; none is configured");
    const receipt = this.options.resolveReceipt(input.approvalRef);
    return withRootWriteLock(this.root, () => {
      const again = this.invariants.replayHeld(operationId, request);
      if (again) return { ...again, replayed: true };
      const incidents = this.incidents.readHeld();
      const incident = own(incidents.byId, input.incidentId);
      if (!incident) throw new Error("Incident not found");
      if (incident.tier !== "learning_candidate") throw new Error(`Only a learning_candidate can be promoted; this incident is ${incident.tier}`);
      if (own(this.invariants.readHeld().bySourceIncident, input.incidentId)) throw new Error("Incident is already promoted");
      const digest = invariantDigest({ incidentId: input.incidentId, cluster: incident.cluster, preventionRule: incident.preventionRule, violatedInvariant: incident.violatedInvariant });
      assertOwnerApproval(receipt, { reference: input.approvalRef, incidentId: input.incidentId, digest }, (this.options.clock ?? (() => new Date()))());
      const result = this.invariants.appendHeld(operationId, request, () => ({
        type: "accepted" as const,
        invariantId: `invariant:${crypto.randomUUID()}`,
        cluster: incident.cluster,
        rule: incident.preventionRule,
        violatedInvariant: incident.violatedInvariant,
        sourceIncidentId: input.incidentId,
        approvalRef: input.approvalRef,
        surface: input.surface,
      }));
      return result;
    }, this.options.lock);
  }

  /** Accepted invariants for a cluster. Never candidates. */
  rulesFor(clusterId: string | null, limit = 10): Invariant[] {
    if (!clusterId) return [];
    return Object.values(this.invariants.read().byId).filter((item) => item.cluster === clusterId && item.status === "active").slice(-limit);
  }

  incidentSummaries(filter: { cluster?: string | null; workId?: string | null }, limit = 10) {
    return Object.entries(this.incidents.read().byId)
      .filter(([, item]) => (filter.workId && item.workId === filter.workId) || (filter.cluster && item.cluster === filter.cluster))
      .slice(-limit)
      .map(([id, item]) => ({ id, kind: item.kind, summary: item.summary, correction: item.correction, tier: item.tier, recorded_at: item.recordedAt }));
  }

  auditTrail(workId: string, clusterId: string | null) {
    const holding = holdsRootWriteLock(this.root);
    const incidents = (holding ? this.incidents.eventsHeld() : this.incidents.events())
      .filter((item) => item.workId === workId || (clusterId && item.cluster === clusterId)).slice(-25);
    const chronicle = (holding ? this.chronicle.eventsHeld() : this.chronicle.events()).filter((item) => item.workId === workId).slice(-50);
    return { incidents, chronicle };
  }

  checkAction(input: CheckActionInput) {
    const clusterId = cluster(input.cluster);
    const checked: CheckActionInput = {
      cluster: clusterId,
      actionSummary: text(input.actionSummary, "action_summary", 1_000),
      requestedSurface: input.requestedSurface,
      targetName: input.targetName,
      semanticIdentityProof: input.semanticIdentityProof,
      repeatedAttempts: input.repeatedAttempts,
      progressMarker: input.progressMarker,
    };
    if (checked.repeatedAttempts !== undefined && (!Number.isInteger(checked.repeatedAttempts) || checked.repeatedAttempts < 0)) {
      throw new Error("repeated_attempts must be a non-negative integer");
    }
    const blockers = (this.options.guards ?? [])
      .filter((guard) => GUARDS[guard].blocks(checked))
      .map((guard) => ({ guard, reason: GUARDS[guard].description }));
    return {
      allowed: blockers.length === 0,
      blockers,
      accepted_invariants: this.rulesFor(clusterId).map((item) => ({ id: item.invariantId, rule: item.rule, approval_ref: item.approvalRef })),
      note: "Guards are evaluated here. Accepted invariants are returned for the agent to apply; candidates and raw incidents are never policy.",
    };
  }
}
