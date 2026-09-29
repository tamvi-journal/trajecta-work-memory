/**
 * Skill evolution (Phase 3 §B, docs/specs/2026-09-29-phase3-cases-skills-claims.md).
 *
 * pattern → version → validation → activate / rollback, in one domain journal
 * (`skills.jsonl` → `skill-index.json`).
 *
 * - A version is immutable. A skill's first version has no parent; every
 *   later version names an existing parent.
 * - An accepted validation needs candidate > baseline, and a validator
 *   session different from the proposer's (D2). The server stamps both from
 *   the surface it runs as. Imported validations are history: never eligible.
 * - Activation needs an owner receipt (`skill_activation`) bound to skill,
 *   version, expected parent, pointer epoch, decision and content digest. It
 *   is a CAS on the active pointer: only a direct child of the active version
 *   activates. The pointer epoch rises on every activation and rollback, so an
 *   old receipt never becomes valid again after the pointer moves (no ABA).
 * - Rollback needs an owner receipt (`skill_rollback`) and can only return to
 *   a version that was active before.
 * - Candidates never reach normal context: agents see active versions only.
 */
import crypto from "node:crypto";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { own } from "./clusters.ts";
import { withRootWriteLock, type LockOptions } from "./lock.ts";
import { cluster as clusterId, refs, slug, text } from "./learning.ts";
import { assertSkillActivation, assertSkillRollback, reasonDigest } from "./receipts.ts";
import type { Surface } from "./types.ts";

export const VALIDATION_OUTCOMES = ["accepted", "rejected", "blocked", "expired"] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];
type Attestation = "agent" | "imported";

export interface VersionRecord {
  parentVersionId: string | null;
  cluster: string;
  content: string;
  contentDigest: string;
  unifiedDiff: string | null;
  motivatingRefs: string[];
  proposer: Surface;
  targetSurfaces: string[];
  validationPlan: string | null;
  attestation: Attestation;
  recordedAt: string;
}

export interface ValidationRecord {
  skillId: string;
  versionId: string;
  outcome: ValidationOutcome;
  baselineScore: number | null;
  candidateScore: number | null;
  evidenceRefs: string[];
  reason: string;
  validator: Surface;
  attestation: Attestation;
  /** Can back an activation: accepted, agent-attested, independent validator. */
  eligible: boolean;
  recordedAt: string;
}

export interface SkillRecord {
  cluster: string;
  active: string | null;
  /** Rises by one on every activation or rollback; never resets. Owner receipts bind it. */
  pointerEpoch: number;
  everActive: string[];
  versions: Record<string, VersionRecord>;
}

export interface PatternRevision {
  revisionId: string;
  previousRevisionId: string | null;
  title: string;
  summary: string;
  evidenceRefs: string[];
  recordedAt: string;
}

export interface SkillIndex {
  skills: Record<string, SkillRecord>;
  validations: Record<string, ValidationRecord>;
  patterns: Record<string, { latestRevisionId: string; revisions: PatternRevision[] }>;
}

type Body =
  | ({ type: "pattern"; patternId: string; surface: Surface; attestation: Attestation; provenance?: string[] } & Omit<PatternRevision, "recordedAt">)
  | ({ type: "version"; skillId: string; versionId: string; provenance?: string[] } & Omit<VersionRecord, "recordedAt">)
  | ({ type: "validation"; decisionId: string; provenance?: string[] } & Omit<ValidationRecord, "recordedAt">)
  | { type: "activated"; skillId: string; versionId: string; previousVersionId: string | null; pointerEpoch: number; decisionId: string; approvalRef: string; surface: Surface }
  | { type: "rolled_back"; skillId: string; fromVersionId: string; toVersionId: string; pointerEpoch: number; reason: string; evidenceRefs: string[]; approvalRef: string; surface: Surface };

export type SkillEvent = JournalEvent & Body;

export const SKILLS: DomainSpec<SkillIndex, SkillEvent> = {
  name: "skills",
  projectionFile: "skill-index.json",
  projectionSchema: "trajecta.skill-index/v1",
  empty: () => ({ skills: {}, validations: {}, patterns: {} }),
  apply(index, event) {
    const at = event.recordedAt;
    switch (event.type) {
      case "pattern": {
        const entry = own(index.patterns, event.patternId) ?? { latestRevisionId: event.revisionId, revisions: [] };
        entry.revisions.push({ revisionId: event.revisionId, previousRevisionId: event.previousRevisionId, title: event.title, summary: event.summary, evidenceRefs: event.evidenceRefs, recordedAt: at });
        entry.latestRevisionId = event.revisionId;
        index.patterns[event.patternId] = entry;
        break;
      }
      case "version": {
        const { type: _t, skillId, versionId, id: _id, operationId: _op, recordedAt: _at, provenance: _p, ...record } = event;
        const skill = own(index.skills, skillId) ?? { cluster: record.cluster, active: null, pointerEpoch: 0, everActive: [], versions: {} };
        skill.versions[versionId] = { ...record, recordedAt: at };
        index.skills[skillId] = skill;
        break;
      }
      case "validation": {
        const { type: _t, decisionId, id: _id, operationId: _op, recordedAt: _at, provenance: _p, ...record } = event;
        index.validations[decisionId] = { ...record, recordedAt: at };
        break;
      }
      case "activated":
      case "rolled_back": {
        const skill = own(index.skills, event.skillId);
        if (!skill) break;
        const to = event.type === "activated" ? event.versionId : event.toVersionId;
        skill.active = to;
        skill.pointerEpoch = (skill.pointerEpoch ?? 0) + 1;
        if (!skill.everActive.includes(to)) skill.everActive.push(to);
        break;
      }
    }
    return index;
  },
  isEvent: (value: unknown): value is SkillEvent => {
    const event = value as Partial<SkillEvent> | null;
    return Boolean(event) && typeof event!.id === "string" && ["pattern", "version", "validation", "activated", "rolled_back"].includes(event!.type as string);
  },
};

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function ident(value: unknown, label: string) {
  if (typeof value !== "string" || !IDENT.test(value)) throw new Error(`${label} must be an id of letters, digits and . _ : -`);
  return value;
}

const sessionOf = (surface: Surface) => `${surface.kind}:${surface.session}`;
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function score(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a number in 0..1`);
  return value;
}

export interface SkillOptions {
  clock?: () => Date;
  lock?: LockOptions;
  resolveReceipt?: (reference: string) => unknown;
}

export class SkillLayer {
  readonly journal: DomainJournal<SkillIndex, SkillEvent>;
  private readonly root: string;
  private readonly options: SkillOptions;

  constructor(root: string, options: SkillOptions = {}) {
    this.root = root;
    this.options = options;
    this.journal = new DomainJournal(root, SKILLS, options.clock, undefined, options.lock);
  }

  private now() {
    return (this.options.clock ?? (() => new Date()))();
  }

  private write(operationId: string, request: unknown, build: (index: SkillIndex) => Body) {
    return withRootWriteLock(this.root, () => {
      const replayed = this.journal.replayHeld(operationId, request);
      if (replayed) return { ...replayed, replayed: true };
      return { ...this.journal.appendHeld(operationId, request, (index) => build(index)), replayed: false };
    }, this.options.lock);
  }

  /** Record a pattern revision. previous_revision_id must be the latest revision (null for the first). */
  recordPattern(operationId: string, input: { patternId: string; previousRevisionId?: string | null; title: string; summary: string; evidenceRefs: string[]; surface: Surface; imported?: { provenance: string[] } }) {
    const evidenceRefs = refs(input.evidenceRefs, "evidence_refs");
    if (!evidenceRefs.length && !input.imported) throw new Error("A pattern needs evidence_refs");
    const request = {
      patternId: ident(input.patternId, "pattern_id"), previousRevisionId: input.previousRevisionId ?? null,
      title: text(input.title, "title", 200), summary: text(input.summary, "summary", 2_000), evidenceRefs,
      surface: input.surface, attestation: (input.imported ? "imported" : "agent") as Attestation,
      ...(input.imported ? { provenance: refs(input.imported.provenance, "provenance") } : {}),
    };
    return this.write(operationId, request, (index) => {
      const latest = own(index.patterns, request.patternId)?.latestRevisionId ?? null;
      if (request.previousRevisionId !== latest) {
        throw new Error(latest ? `previous_revision_id must be the latest revision ${latest}` : "The first revision of a pattern has no previous_revision_id");
      }
      return { type: "pattern", ...request, revisionId: `revision:${crypto.randomUUID()}` };
    });
  }

  /** Propose an immutable skill version. */
  proposeVersion(operationId: string, input: {
    skillId: string; versionId: string; parentVersionId?: string | null; cluster: string; content: string; unifiedDiff?: string | null;
    motivatingRefs: string[]; targetSurfaces?: string[]; validationPlan?: string | null; surface: Surface; imported?: { provenance: string[] };
  }) {
    const content = text(input.content, "content", 50_000);
    const motivatingRefs = refs(input.motivatingRefs, "motivating_refs");
    if (!motivatingRefs.length && !input.imported) throw new Error("A version needs motivating_refs");
    const request = {
      skillId: ident(input.skillId, "skill_id"), versionId: ident(input.versionId, "version_id"),
      parentVersionId: input.parentVersionId ?? null, cluster: clusterId(input.cluster), content, contentDigest: sha256(content),
      unifiedDiff: input.unifiedDiff ? text(input.unifiedDiff, "unified_diff", 50_000) : null, motivatingRefs,
      proposer: input.surface, targetSurfaces: [...new Set(input.targetSurfaces ?? [])].map((item) => slug(item, "target_surface")),
      validationPlan: input.validationPlan ? text(input.validationPlan, "validation_plan", 4_000) : null,
      attestation: (input.imported ? "imported" : "agent") as Attestation,
      ...(input.imported ? { provenance: refs(input.imported.provenance, "provenance") } : {}),
    };
    return this.write(operationId, request, (index) => {
      const skill = own(index.skills, request.skillId);
      if (skill && own(skill.versions, request.versionId)) throw new Error(`Version ${request.versionId} of ${request.skillId} already exists`);
      if (skill && skill.cluster !== request.cluster) throw new Error(`Skill ${request.skillId} belongs to cluster ${skill.cluster}`);
      const hasVersions = Boolean(skill && Object.keys(skill.versions).length);
      if (request.parentVersionId === null && hasVersions) throw new Error("Only a skill's first version has no parent_version_id");
      if (request.parentVersionId !== null && !(skill && own(skill.versions, request.parentVersionId))) throw new Error(`Parent version ${request.parentVersionId} not found`);
      return { type: "version", ...request };
    });
  }

  /** Record a validation decision for one version. */
  recordValidation(operationId: string, input: {
    skillId: string; versionId: string; outcome: ValidationOutcome; baselineScore?: number | null; candidateScore?: number | null;
    evidenceRefs: string[]; reason: string; surface: Surface; imported?: { provenance: string[] };
  }) {
    if (!VALIDATION_OUTCOMES.includes(input.outcome)) throw new Error(`outcome must be one of ${VALIDATION_OUTCOMES.join(", ")}`);
    const baselineScore = score(input.baselineScore, "baseline_score");
    const candidateScore = score(input.candidateScore, "candidate_score");
    const evidenceRefs = refs(input.evidenceRefs, "evidence_refs");
    if (!evidenceRefs.length && !input.imported) throw new Error("A validation needs evidence_refs");
    if (input.outcome === "accepted" && !input.imported) {
      if (baselineScore === null || candidateScore === null) throw new Error("accepted needs baseline_score and candidate_score");
      if (!(candidateScore > baselineScore)) throw new Error("accepted needs candidate_score strictly above baseline_score");
    }
    const request = {
      skillId: ident(input.skillId, "skill_id"), versionId: ident(input.versionId, "version_id"), outcome: input.outcome,
      baselineScore, candidateScore, evidenceRefs, reason: text(input.reason, "reason", 1_000), validator: input.surface,
      attestation: (input.imported ? "imported" : "agent") as Attestation,
      ...(input.imported ? { provenance: refs(input.imported.provenance, "provenance") } : {}),
    };
    return this.write(operationId, request, (index) => {
      const version = own(own(index.skills, request.skillId)?.versions ?? {}, request.versionId);
      if (!version) throw new Error(`Version ${request.versionId} of ${request.skillId} not found`);
      if (request.outcome === "accepted" && !input.imported && sessionOf(version.proposer) === sessionOf(request.validator)) {
        throw new Error("An accepted validation must come from a different session than the one that proposed the version");
      }
      const eligible = request.outcome === "accepted" && request.attestation === "agent";
      return { type: "validation", ...request, decisionId: `decision:${crypto.randomUUID()}`, eligible };
    });
  }

  /** What an activation must bind, for the owner CLI and for the check. */
  activationTerms(index: SkillIndex, skillId: string, versionId: string, decisionId: string) {
    const skill = own(index.skills, skillId);
    const version = own(skill?.versions ?? {}, versionId);
    if (!skill || !version) throw new Error(`Version ${versionId} of ${skillId} not found`);
    const decision = own(index.validations, decisionId);
    if (!decision || decision.skillId !== skillId || decision.versionId !== versionId) throw new Error(`${decisionId} is not a validation of ${skillId} ${versionId}`);
    if (!decision.eligible) throw new Error(`${decisionId} cannot back an activation (needs an accepted, independent validation recorded in this store)`);
    if (skill.active !== version.parentVersionId) {
      throw new Error(`Only a direct child of the active version can activate: active is ${skill.active ?? "none"}, ${versionId}'s parent is ${version.parentVersionId ?? "none"}`);
    }
    return { skillId, versionId, expectedParentVersionId: version.parentVersionId, expectedPointerEpoch: skill.pointerEpoch ?? 0, decisionId, contentDigest: version.contentDigest };
  }

  /** Terms a rollback must bind. */
  rollbackTerms(index: SkillIndex, skillId: string, toVersionId: string, reason: string) {
    const skill = own(index.skills, skillId);
    if (!skill) throw new Error(`Skill ${skillId} not found`);
    if (!skill.active) throw new Error(`${skillId} has no active version to roll back`);
    if (toVersionId === skill.active) throw new Error(`${toVersionId} is already active`);
    if (!skill.everActive.includes(toVersionId)) throw new Error(`Rollback can only return to a version that was active before; ${toVersionId} never was`);
    return { skillId, fromVersionId: skill.active, toVersionId, expectedPointerEpoch: skill.pointerEpoch ?? 0, reasonDigest: reasonDigest(text(reason, "reason", 1_000)) };
  }

  /** Activate a version with an owner receipt. Locked replay → unlocked resolve → locked re-check + append. */
  activate(operationId: string, input: { skillId: string; versionId: string; decisionId: string; approvalRef: string; surface: Surface }) {
    const request = { skillId: input.skillId, versionId: input.versionId, decisionId: input.decisionId, approvalRef: input.approvalRef };
    const done = withRootWriteLock(this.root, () => this.journal.replayHeld(operationId, request), this.options.lock);
    if (done) return { ...done, replayed: true };
    ident(input.skillId, "skill_id"); ident(input.versionId, "version_id");
    if (typeof input.approvalRef !== "string" || !/^receipt:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.approvalRef)) throw new Error("approval_ref must be a receipt reference");
    if (!this.options.resolveReceipt) throw new Error("Activating a skill needs a receipt verifier; none is configured");
    const receipt = this.options.resolveReceipt(input.approvalRef);
    return withRootWriteLock(this.root, () => {
      const again = this.journal.replayHeld(operationId, request);
      if (again) return { ...again, replayed: true };
      const terms = this.activationTerms(this.journal.readHeld(), input.skillId, input.versionId, input.decisionId);
      assertSkillActivation(receipt, { reference: input.approvalRef, ...terms }, this.now());
      return { ...this.journal.appendHeld(operationId, request, () => ({
        type: "activated" as const, skillId: terms.skillId, versionId: terms.versionId, previousVersionId: terms.expectedParentVersionId, pointerEpoch: terms.expectedPointerEpoch + 1,
        decisionId: terms.decisionId, approvalRef: input.approvalRef, surface: input.surface,
      })), replayed: false };
    }, this.options.lock);
  }

  /** Roll back to a version that was active before, with an owner receipt. */
  rollback(operationId: string, input: { skillId: string; toVersionId: string; reason: string; evidenceRefs?: string[]; approvalRef: string; surface: Surface }) {
    const evidenceRefs = refs(input.evidenceRefs, "evidence_refs");
    const request = { skillId: input.skillId, toVersionId: input.toVersionId, reason: input.reason, evidenceRefs, approvalRef: input.approvalRef };
    const done = withRootWriteLock(this.root, () => this.journal.replayHeld(operationId, request), this.options.lock);
    if (done) return { ...done, replayed: true };
    ident(input.skillId, "skill_id"); ident(input.toVersionId, "to_version_id"); text(input.reason, "reason", 1_000);
    if (typeof input.approvalRef !== "string" || !/^receipt:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.approvalRef)) throw new Error("approval_ref must be a receipt reference");
    if (!this.options.resolveReceipt) throw new Error("Rolling back a skill needs a receipt verifier; none is configured");
    const receipt = this.options.resolveReceipt(input.approvalRef);
    return withRootWriteLock(this.root, () => {
      const again = this.journal.replayHeld(operationId, request);
      if (again) return { ...again, replayed: true };
      const terms = this.rollbackTerms(this.journal.readHeld(), input.skillId, input.toVersionId, input.reason);
      assertSkillRollback(receipt, { reference: input.approvalRef, ...terms }, this.now());
      return { ...this.journal.appendHeld(operationId, request, () => ({
        type: "rolled_back" as const, skillId: terms.skillId, fromVersionId: terms.fromVersionId, toVersionId: terms.toVersionId, pointerEpoch: terms.expectedPointerEpoch + 1,
        reason: input.reason.trim(), evidenceRefs, approvalRef: input.approvalRef, surface: input.surface,
      })), replayed: false };
    }, this.options.lock);
  }

  /** Active skills of a cluster, without content. Never candidates. */
  activeFor(cluster: string | null) {
    if (!cluster) return [];
    return Object.entries(this.journal.read().skills)
      .filter(([, skill]) => skill.cluster === cluster && skill.active)
      .map(([skillId, skill]) => ({ skill_id: skillId, version_id: skill.active!, content_digest: skill.versions[skill.active!].contentDigest, pointer_epoch: skill.pointerEpoch ?? 0 }));
  }

  /** The active content of a skill; audit adds its whole history. */
  getSkill(skillId: string, mode: "normal" | "audit" = "normal") {
    const index = this.journal.read();
    const skill = own(index.skills, ident(skillId, "skill_id"));
    if (!skill) throw new Error(`Skill ${skillId} not found`);
    const active = skill.active ? skill.versions[skill.active] : null;
    return {
      skill_id: skillId, cluster: skill.cluster, pointer_epoch: skill.pointerEpoch ?? 0,
      active: active ? { version_id: skill.active, content: active.content, content_digest: active.contentDigest } : null,
      ...(mode === "audit" ? {
        ever_active: skill.everActive,
        versions: Object.entries(skill.versions).map(([versionId, version]) => ({ version_id: versionId, ...version })),
        validations: Object.entries(index.validations).filter(([, item]) => item.skillId === skillId).map(([decisionId, item]) => ({ decision_id: decisionId, ...item })),
        pointer_events: this.journal.events().filter((event) => (event.type === "activated" || event.type === "rolled_back") && event.skillId === skillId),
      } : {}),
    };
  }
}
