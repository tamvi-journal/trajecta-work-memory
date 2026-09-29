/**
 * Stdio MCP server for Trajecta work memory (JSON-RPC, one message per line).
 *
 * No network listener and no dependencies. The store is single-writer: run one
 * server per store. Every write carries the expected revision, so a stale
 * surface gets a RevisionConflict instead of overwriting newer work.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RevisionConflict, TrajectaStore } from "./store.ts";
import { TrajectaRelay } from "./relay.ts";
import { bootstrap, CAPABILITY_SNAPSHOTS, loadProfile, type WorkProfile } from "./boot.ts";
import { CLUSTER_ID, clusterJournal, hasCluster, routeClusters } from "./clusters.ts";
import { workContext, type ContextMode } from "./context.ts";
import { DomainJournal } from "./journal.ts";
import { assertSafe, UnsafeInput } from "./safety.ts";
import { CHRONICLE_STAGES, LearningLayer, type ChronicleStage } from "./learning.ts";
import { receiptResolver } from "./receipts.ts";
import { CASE_STATUSES, CaseLayer, HYPOTHESIS_STATUSES, type CaseStatus, type HypothesisStatus } from "./cases.ts";
import { SkillLayer, VALIDATION_OUTCOMES, type ValidationOutcome } from "./skills.ts";
import { claimFence, ClaimLayer } from "./claims.ts";
import type { DeltaKind, Surface, SurfaceKind } from "./types.ts";

export const SERVER_NAME = "trajecta-work-memory";
export const SERVER_VERSION = "0.5.0";
const CAPTURE_KINDS: DeltaKind[] = [
  "instruction", "decision", "progress", "blocker", "correction", "next_action",
  "branch_open", "branch_park", "synthesis", "outcome", "contract_anchor",
];

type Json = Record<string, unknown>;

/** Platform data folder; TRAJECTA_HOME overrides it. */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TRAJECTA_HOME?.trim()) return path.resolve(env.TRAJECTA_HOME);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Trajecta Work Memory");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Trajecta Work Memory");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "trajecta-work-memory");
}

export function surfaceFrom(env: NodeJS.ProcessEnv = process.env): Surface {
  const kind = (env.TRAJECTA_SURFACE_KIND || "local") as SurfaceKind;
  if (kind !== "cloud" && kind !== "local") throw new Error("TRAJECTA_SURFACE_KIND must be cloud or local");
  return {
    kind,
    name: env.TRAJECTA_SURFACE_NAME || (kind === "local" ? "Local agent" : "Cloud agent"),
    session: env.TRAJECTA_SURFACE_SESSION || `${kind}:mcp`,
  };
}

const str = { type: "string" };
const strs = { type: "array", items: str, maxItems: 20 };
const rev = { type: "integer", minimum: 1 };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function tool(name: string, description: string, properties: Json = {}, required: string[] = [], annotations = RO) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations };
}
const opId = { type: "string", maxLength: 200, description: "Optional idempotency key such as operation:abc-123. Retrying with the same key and input returns the same result." };
const claimEpoch = { type: "integer", minimum: 1, description: "Your claim epoch (from work_claim). Required only while the work has a live claim." };
const caseIdS = { type: "string", pattern: "^case:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$" };
const hypothesisIdS = { type: "string", pattern: "^hypothesis:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$" };
const ident = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" };

export const TOOLS = [
  tool("work_list", "List work items: id, topic, status, revision, next action, open loops."),
  tool("work_route", "Find the work item a cue belongs to. Returns compact candidates only.",
    { cue: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["cue"]),
  tool("work_get", "Read one work item and its most recent deltas (decisions, blockers, outcomes…).",
    { work_id: str, recent: { type: "integer", minimum: 0, maximum: 50 } }, ["work_id"]),
  tool("work_open", "Open a new work item. Optionally start a branch with a purpose, cues and a return point.",
    {
      topic: { type: "string", minLength: 1, maxLength: 200 },
      goal: { type: "string", minLength: 1, maxLength: 1000 },
      instruction: { type: "string", maxLength: 1000 },
      branch: {
        type: "object",
        properties: { label: str, purpose: str, cues: strs, return_point: str },
        required: ["label", "purpose", "cues", "return_point"],
        additionalProperties: false,
      },
      operation_id: opId,
    }, ["topic", "goal"], W),
  tool("work_capture", "Record a material change: a decision, progress, blocker, correction, next action, outcome, synthesis, or a branch opening/parking. Needs the current revision; a stale revision is rejected.",
    {
      work_id: str,
      expected_revision: rev,
      kind: { type: "string", enum: CAPTURE_KINDS },
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      provenance: strs,
      open_loops: strs,
      next_action: { type: ["string", "null"], maxLength: 1000 },
      branch_id: str,
      branch: {
        type: "object",
        properties: { label: str, purpose: str, cues: strs, return_point: str },
        required: ["label", "purpose", "cues", "return_point"],
        additionalProperties: false,
      },
      claim_epoch: claimEpoch,
      operation_id: opId,
    }, ["work_id", "expected_revision", "kind", "summary"], W),
  tool("work_handoff", "Hand work to the other surface (cloud ⇄ local). Records the handoff and returns a bounded transfer packet.",
    {
      work_id: str,
      expected_revision: rev,
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      cue: { type: "string", minLength: 1, maxLength: 500 },
      provenance: strs,
      open_loops: strs,
      next_action: { type: ["string", "null"], maxLength: 1000 },
      claim_epoch: claimEpoch,
      operation_id: opId,
    }, ["work_id", "expected_revision", "summary", "cue"], W),
  tool("work_resume", "Resume work on this surface at the expected revision.",
    { work_id: str, expected_revision: rev, instruction: { type: "string", maxLength: 1000 }, claim_epoch: claimEpoch, operation_id: opId },
    ["work_id", "expected_revision"], W),
  tool("work_packet", "Render a bounded transfer packet for one work item without changing anything.",
    { work_id: str, cue: { type: "string", minLength: 1, maxLength: 500 }, target: { type: "string", enum: ["cloud", "local"] } },
    ["work_id", "cue", "target"]),
  tool("work_bootstrap", "Call once at the start of a session: returns the working rules (kernel), a capability snapshot for this surface, canonical entrypoints, known clusters and the open-work index.",
    {
      evidence: {
        type: "object",
        description: "What this surface can use right now (observation, not authorisation).",
        properties: { directTools: strs, executors: strs, skills: strs, memoryBackends: strs, unknowns: strs, gotchas: strs },
        additionalProperties: false,
      },
      operation_id: opId,
    }, [], W),
  tool("work_route_clusters", "Route a message to clusters with the cue registry (deterministic: primary > alias > detail).",
    { message: { type: "string", minLength: 1, maxLength: 2000 }, active_clusters: strs }, ["message"]),
  tool("work_assign_cluster", "Put a work item in a cluster. Does not change the work item's revision.",
    { work_id: str, cluster: { type: "string", pattern: CLUSTER_ID.source }, reason: { type: "string", minLength: 1, maxLength: 300 }, operation_id: opId },
    ["work_id", "cluster", "reason"], W),
  tool("work_record_incident", "Record an incident: an agent broke a rule, chose the wrong rail or lost the goal. Same cluster+kind+violated invariant with distinct evidence climbs raw → repeated → learning_candidate. Never becomes policy by itself.",
    {
      work_id: str,
      cluster: { type: "string", pattern: CLUSTER_ID.source },
      kind: { type: "string", maxLength: 64 },
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      violated_invariant: { type: "string", minLength: 1, maxLength: 500 },
      evidence_refs: { ...strs, minItems: 1 },
      correction: { type: "string", minLength: 1, maxLength: 1000 },
      prevention_rule: { type: "string", minLength: 1, maxLength: 1000 },
      root_cause: { type: "string", maxLength: 300 },
      operation_id: opId,
    }, ["cluster", "kind", "summary", "violated_invariant", "evidence_refs", "correction", "prevention_rule"], W),
  tool("work_record_friction", "Record friction: a tool or system was hard to use (not an agent mistake).",
    { work_id: str, cluster: { type: "string", pattern: CLUSTER_ID.source }, component: { type: "string", maxLength: 64 }, kind: { type: "string", maxLength: 64 }, summary: { type: "string", minLength: 1, maxLength: 1000 }, provenance: strs, operation_id: opId },
    ["cluster", "component", "kind", "summary"], W),
  tool("work_record_milestone", "Add one chronicle milestone to a work item (goal, decision, rail, action, outcome, blocker, correction, next_action). Never a transcript.",
    { work_id: str, cluster: { type: "string", pattern: CLUSTER_ID.source }, stage: { type: "string", enum: [...CHRONICLE_STAGES] }, summary: { type: "string", minLength: 1, maxLength: 1000 }, provenance: strs, operation_id: opId },
    ["work_id", "stage", "summary"], W),
  tool("work_promote_incident", "Turn a learning_candidate incident into an accepted prevention rule. Needs an owner-approval receipt the owner issued with `trajecta approve-promotion`; agents cannot issue one.",
    { incident_id: str, approval_ref: str, operation_id: opId }, ["incident_id", "approval_ref"], W),
  tool("work_check_action", "Before a consequential action: the profile's guards that block it, and the accepted rules for the cluster to apply. Does not run the action.",
    {
      cluster: { type: "string", pattern: CLUSTER_ID.source },
      action_summary: { type: "string", minLength: 1, maxLength: 1000 },
      requested_surface: { type: "string", maxLength: 40 },
      target_name: { type: "string", maxLength: 200 },
      semantic_identity_proof: { type: "string", maxLength: 500 },
      repeated_attempts: { type: "integer", minimum: 0 },
      progress_marker: { type: "string", maxLength: 500 },
    }, ["cluster", "action_summary"]),
  tool("work_close", "Close a work item as complete or abandoned. Needs a work-close receipt the owner issued with `trajecta approve-close` for this exact revision and request.",
    {
      work_id: str, expected_revision: rev, status: { type: "string", enum: ["complete", "abandoned"] },
      summary: { type: "string", minLength: 1, maxLength: 1000 }, verification_ref: str, provenance: strs, claim_epoch: claimEpoch, operation_id: opId,
    }, ["work_id", "expected_revision", "status", "summary", "verification_ref"], W),
  tool("work_context", "Bounded context for one work item (or the open work in one cluster). mode: normal | debug | audit.",
    {
      work_id: str,
      cluster: { type: "string", pattern: CLUSTER_ID.source },
      mode: { type: "string", enum: ["normal", "debug", "audit"] },
      budget_chars: { type: "integer", minimum: 800, maximum: 60000 },
    }, ["mode"]),
  tool("work_claim", "Claim exclusive execution of a work item for this session (a lease, default 120 minutes). While the claim is live, other sessions cannot capture, resume or close the work, and you must pass claim_epoch. Claiming again renews your own claim. Handoff does not move a claim: release it, and the receiver claims.",
    { work_id: str, lease_minutes: { type: "integer", minimum: 1, maximum: 720 }, operation_id: opId }, ["work_id"], W),
  tool("work_release", "Release your claim on a work item (holder session and exact epoch must match).",
    { work_id: str, claim_epoch: { type: "integer", minimum: 1 }, operation_id: opId }, ["work_id", "claim_epoch"], W),
  tool("work_case_open", "Open a debug case over one or more work items.",
    { case_id: caseIdS, title: { type: "string", minLength: 1, maxLength: 200 }, work_ids: { ...strs, minItems: 1 }, signatures: strs, evidence_refs: { ...strs, minItems: 1 }, operation_id: opId },
    ["case_id", "title", "work_ids", "evidence_refs"], W),
  tool("work_case_event", "Add or remove an incident in a case, or move its status (open → resolved | challenged | deprioritized …). resolved needs resolution_hypothesis_ids: supported hypotheses of this case, at least one attested here.",
    {
      case_id: caseIdS, event_type: { type: "string", enum: ["member_added", "member_removed", "status"] }, incident_id: str,
      status: { type: "string", enum: [...CASE_STATUSES] }, resolution_hypothesis_ids: strs, evidence_refs: { ...strs, minItems: 1 }, operation_id: opId,
    }, ["case_id", "event_type", "evidence_refs"], W),
  tool("work_hypothesis", "Propose a hypothesis in a case, or record its verdict. supported/refuted need verification_ref (test:, commit:, tool:, artifact: or audit:) listed in supporting_refs / disconfirming_refs. A verdict is final; a new idea is a new hypothesis. Hypotheses never become policy.",
    {
      hypothesis_id: hypothesisIdS, case_id: caseIdS, status: { type: "string", enum: [...HYPOTHESIS_STATUSES] },
      statement: { type: "string", minLength: 1, maxLength: 1000 }, signature: str, supporting_refs: strs, disconfirming_refs: strs,
      discriminating_check: { type: "string", maxLength: 1000 }, verification_ref: str, operation_id: opId,
    }, ["hypothesis_id", "case_id", "status", "statement"], W),
  tool("work_case_get", "Read one case and its hypotheses. mode: normal | debug | audit.",
    { case_id: caseIdS, mode: { type: "string", enum: ["normal", "debug", "audit"] } }, ["case_id"]),
  tool("work_skill_pattern", "Record a revision of an observed skill pattern. previous_revision_id must be the latest revision (omit for the first).",
    { pattern_id: ident, previous_revision_id: str, title: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 2000 }, evidence_refs: { ...strs, minItems: 1 }, operation_id: opId },
    ["pattern_id", "title", "summary", "evidence_refs"], W),
  tool("work_skill_propose", "Propose an immutable skill version. A skill's first version has no parent; later versions name their parent. Proposing never activates.",
    {
      skill_id: ident, version_id: ident, parent_version_id: ident, cluster: { type: "string", pattern: CLUSTER_ID.source },
      content: { type: "string", minLength: 1, maxLength: 50000 }, unified_diff: { type: "string", maxLength: 50000 }, motivating_refs: { ...strs, minItems: 1 },
      target_surfaces: strs, validation_plan: { type: "string", maxLength: 4000 }, operation_id: opId,
    }, ["skill_id", "version_id", "cluster", "content", "motivating_refs"], W),
  tool("work_skill_validate", "Record a validation of a skill version. accepted needs candidate_score > baseline_score (0..1) and must come from a different session than the proposer.",
    {
      skill_id: ident, version_id: ident, outcome: { type: "string", enum: [...VALIDATION_OUTCOMES] },
      baseline_score: { type: "number", minimum: 0, maximum: 1 }, candidate_score: { type: "number", minimum: 0, maximum: 1 },
      evidence_refs: { ...strs, minItems: 1 }, reason: { type: "string", minLength: 1, maxLength: 1000 }, operation_id: opId,
    }, ["skill_id", "version_id", "outcome", "evidence_refs", "reason"], W),
  tool("work_skill_activate", "Make a validated version the active one. Needs a receipt the owner issued with `trajecta approve-skill` for this exact version, decision and current active version.",
    { skill_id: ident, version_id: ident, decision_id: str, approval_ref: str, operation_id: opId }, ["skill_id", "version_id", "decision_id", "approval_ref"], W),
  tool("work_skill_rollback", "Return a skill to a version that was active before. Needs a receipt the owner issued with `trajecta approve-rollback`.",
    { skill_id: ident, to_version_id: ident, reason: { type: "string", minLength: 1, maxLength: 1000 }, evidence_refs: strs, approval_ref: str, operation_id: opId },
    ["skill_id", "to_version_id", "reason", "approval_ref"], W),
  tool("work_skill_get", "Read a skill's active content. mode audit adds versions, validations and pointer history.",
    { skill_id: ident, mode: { type: "string", enum: ["normal", "audit"] } }, ["skill_id"]),
];

function summarize(item: ReturnType<TrajectaStore["getWork"]>) {
  const branch = item.branches.find((candidate) => candidate.id === item.activeBranchId);
  return {
    id: item.id, topic: item.topic, goal: item.goal, status: item.status, revision: item.revision,
    next_action: item.nextAction, open_loops: item.openLoops, active_branch: branch?.label ?? null,
    last_surface: item.lastSurface, updated_at: item.updatedAt,
  };
}

function branchInput(value: unknown) {
  if (!value) return undefined;
  const b = value as { label: string; purpose: string; cues: string[]; return_point: string };
  return { label: b.label, purpose: b.purpose, cues: b.cues, returnPoint: b.return_point };
}

export class WorkServer {
  readonly store: TrajectaStore;
  readonly surface: Surface;
  readonly profile: WorkProfile;
  private readonly clusters;
  private readonly capabilities;
  readonly learning: LearningLayer;
  readonly cases: CaseLayer;
  readonly skills: SkillLayer;
  readonly claims: ClaimLayer;
  constructor(store: TrajectaStore, surface: Surface, options: { profile?: WorkProfile; resolveReceipt?: (reference: string) => unknown } = {}) {
    this.store = store;
    this.surface = surface;
    this.profile = options.profile ?? loadProfile(store.root);
    this.clusters = clusterJournal(store.root);
    this.capabilities = new DomainJournal(store.root, CAPABILITY_SNAPSHOTS);
    const resolveReceipt = options.resolveReceipt ?? receiptResolver(store.root);
    this.learning = new LearningLayer(store, { resolveReceipt, guards: this.profile.guards });
    this.cases = new CaseLayer(store);
    this.skills = new SkillLayer(store.root, { resolveReceipt });
    this.claims = new ClaimLayer(store);
  }

  private epoch(args: Json) {
    return args.claim_epoch === undefined ? {} : { claimEpoch: Number(args.claim_epoch) };
  }

  private op(args: Json) {
    const given = typeof args.operation_id === "string" ? args.operation_id.trim() : "";
    return given || `operation:mcp-${crypto.randomUUID()}`;
  }

  callTool(name: string, args: Json): unknown {
    assertSafe(args, "arguments");
    const s = this.store;
    switch (name) {
      case "work_bootstrap":
        return bootstrap(s, this.profile, this.capabilities, this.clusters, {
          operationId: this.op(args), surface: this.surface, evidence: args.evidence as Record<string, string[]> | undefined,
        });
      case "work_route_clusters": {
        if (!this.profile.cueRegistry) return { selected: [], note: "This profile has no cue registry; use work_route to match work items by cue." };
        return routeClusters(this.profile.cueRegistry, String(args.message), (args.active_clusters as string[] | undefined) ?? []);
      }
      case "work_assign_cluster": {
        const workId = String(args.work_id);
        const cluster = String(args.cluster);
        s.getWork(workId);
        if (!CLUSTER_ID.test(cluster)) throw new Error("Invalid cluster id");
        const registry = this.profile.cueRegistry;
        if (registry && !hasCluster(registry, cluster)) throw new Error(`Unknown cluster ${cluster}; known: ${Object.keys(registry.clusters).join(", ")}`);
        const result = this.clusters.append(this.op(args), { workId, cluster, reason: String(args.reason) }, () => ({
          type: "assign" as const, workId, cluster, reason: String(args.reason), surface: this.surface,
        }));
        return { work_id: workId, cluster, event_id: result.event.id, replayed: result.replayed };
      }
      case "work_record_incident": {
        const result = this.learning.recordIncident(this.op(args), {
          workId: args.work_id as string | undefined, cluster: String(args.cluster), kind: String(args.kind), summary: String(args.summary),
          violatedInvariant: String(args.violated_invariant), evidenceRefs: (args.evidence_refs as string[]) ?? [], correction: String(args.correction),
          preventionRule: String(args.prevention_rule), rootCause: args.root_cause as string | undefined, surface: this.surface,
        });
        const incident = result.event;
        return { incident_id: incident.id, tier: incident.tier, occurrence: incident.occurrence, learning_evidence_count: incident.learningEvidenceCount, replayed: result.replayed };
      }
      case "work_record_friction": {
        const result = this.learning.recordFriction(this.op(args), {
          workId: args.work_id as string | undefined, cluster: String(args.cluster), component: String(args.component), kind: String(args.kind), summary: String(args.summary),
          provenance: args.provenance as string[] | undefined, surface: this.surface,
        });
        return { friction_id: result.event.id, tier: result.event.tier, occurrence: result.event.occurrence, replayed: result.replayed };
      }
      case "work_record_milestone": {
        const result = this.learning.recordMilestone(this.op(args), {
          workId: String(args.work_id), cluster: args.cluster as string | undefined, stage: args.stage as ChronicleStage,
          summary: String(args.summary), provenance: args.provenance as string[] | undefined, surface: this.surface,
        });
        return { milestone_id: result.event.id, replayed: result.replayed };
      }
      case "work_promote_incident": {
        const result = this.learning.promoteIncident(this.op(args), { incidentId: String(args.incident_id), approvalRef: String(args.approval_ref), surface: this.surface });
        return { invariant_id: result.event.invariantId, rule: result.event.rule, cluster: result.event.cluster, replayed: result.replayed };
      }
      case "work_check_action":
        return this.learning.checkAction({
          cluster: String(args.cluster), actionSummary: String(args.action_summary), requestedSurface: args.requested_surface as string | undefined,
          targetName: args.target_name as string | undefined, semanticIdentityProof: args.semantic_identity_proof as string | undefined,
          repeatedAttempts: args.repeated_attempts as number | undefined, progressMarker: args.progress_marker as string | undefined,
        });
      case "work_close": {
        const closed = s.close({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision), surface: this.surface,
          status: args.status as "complete" | "abandoned", summary: String(args.summary), verificationRef: String(args.verification_ref),
          provenance: (args.provenance as string[]) ?? [], ...this.epoch(args),
        });
        return { work: summarize(closed.work), delta: { id: closed.delta.id, revision: closed.delta.revision } };
      }
      case "work_context":
        return workContext(s, this.clusters, {
          workId: typeof args.work_id === "string" ? args.work_id : undefined,
          cluster: typeof args.cluster === "string" ? args.cluster : undefined,
          mode: String(args.mode) as ContextMode,
          budgetChars: args.budget_chars === undefined ? undefined : Number(args.budget_chars),
        }, this.learning, { cases: this.cases, skills: this.skills });
      case "work_claim": {
        if (!s.admits) throw new Error("This store does not enforce claims (no claim fence configured); a claim would not protect anything");
        const result = this.claims.claim(this.op(args), { workId: String(args.work_id), surface: this.surface, leaseMinutes: args.lease_minutes as number | undefined });
        const event = result.event;
        return { work_id: event.workId, claim_id: event.claimId, claim_epoch: event.epoch, expires_at: event.expiresAt, renewed: event.type === "renewed", replayed: result.replayed };
      }
      case "work_release": {
        const result = this.claims.release(this.op(args), { workId: String(args.work_id), surface: this.surface, claimEpoch: Number(args.claim_epoch) });
        return { work_id: result.event.workId, released_epoch: result.event.epoch, replayed: result.replayed };
      }
      case "work_case_open": {
        const result = this.cases.recordCaseEvent(this.op(args), {
          caseId: String(args.case_id), eventType: "open", title: String(args.title), workIds: args.work_ids as string[],
          signatures: args.signatures as string[] | undefined, evidenceRefs: args.evidence_refs as string[], surface: this.surface,
        });
        return { case_id: String(args.case_id), event_id: result.event.id, replayed: result.replayed };
      }
      case "work_case_event": {
        const type = String(args.event_type);
        if (!["member_added", "member_removed", "status"].includes(type)) throw new Error("event_type must be member_added, member_removed or status; use work_case_open to open");
        const result = this.cases.recordCaseEvent(this.op(args), {
          caseId: String(args.case_id), eventType: type as "member_added" | "member_removed" | "status",
          incidentId: args.incident_id as string | undefined, status: args.status as CaseStatus | undefined,
          resolutionHypothesisIds: args.resolution_hypothesis_ids as string[] | undefined, evidenceRefs: args.evidence_refs as string[], surface: this.surface,
        });
        return { case_id: String(args.case_id), event_id: result.event.id, replayed: result.replayed, case: this.cases.getCase(String(args.case_id)) };
      }
      case "work_hypothesis": {
        const result = this.cases.recordHypothesis(this.op(args), {
          hypothesisId: String(args.hypothesis_id), caseId: String(args.case_id), status: args.status as HypothesisStatus,
          statement: String(args.statement), signature: args.signature as string | undefined,
          supportingRefs: args.supporting_refs as string[] | undefined, disconfirmingRefs: args.disconfirming_refs as string[] | undefined,
          discriminatingCheck: args.discriminating_check as string | undefined, verificationRef: args.verification_ref as string | undefined,
          surface: this.surface,
        });
        return { hypothesis_id: String(args.hypothesis_id), status: args.status, event_id: result.event.id, replayed: result.replayed };
      }
      case "work_case_get":
        return this.cases.getCase(String(args.case_id), (args.mode as "normal" | "debug" | "audit" | undefined) ?? "normal");
      case "work_skill_pattern": {
        const result = this.skills.recordPattern(this.op(args), {
          patternId: String(args.pattern_id), previousRevisionId: (args.previous_revision_id as string | undefined) ?? null,
          title: String(args.title), summary: String(args.summary), evidenceRefs: args.evidence_refs as string[], surface: this.surface,
        });
        return { pattern_id: String(args.pattern_id), revision_id: (result.event as { revisionId: string }).revisionId, replayed: result.replayed };
      }
      case "work_skill_propose": {
        const result = this.skills.proposeVersion(this.op(args), {
          skillId: String(args.skill_id), versionId: String(args.version_id), parentVersionId: (args.parent_version_id as string | undefined) ?? null,
          cluster: String(args.cluster), content: String(args.content), unifiedDiff: args.unified_diff as string | undefined,
          motivatingRefs: args.motivating_refs as string[], targetSurfaces: args.target_surfaces as string[] | undefined,
          validationPlan: args.validation_plan as string | undefined, surface: this.surface,
        });
        return { skill_id: String(args.skill_id), version_id: String(args.version_id), content_digest: (result.event as { contentDigest: string }).contentDigest, active: false, replayed: result.replayed };
      }
      case "work_skill_validate": {
        const result = this.skills.recordValidation(this.op(args), {
          skillId: String(args.skill_id), versionId: String(args.version_id), outcome: args.outcome as ValidationOutcome,
          baselineScore: args.baseline_score as number | undefined, candidateScore: args.candidate_score as number | undefined,
          evidenceRefs: args.evidence_refs as string[], reason: String(args.reason), surface: this.surface,
        });
        const event = result.event as { decisionId: string; eligible: boolean };
        return { decision_id: event.decisionId, eligible_for_activation: event.eligible, replayed: result.replayed };
      }
      case "work_skill_activate": {
        const result = this.skills.activate(this.op(args), {
          skillId: String(args.skill_id), versionId: String(args.version_id), decisionId: String(args.decision_id), approvalRef: String(args.approval_ref), surface: this.surface,
        });
        return { skill_id: String(args.skill_id), active_version_id: String(args.version_id), replayed: result.replayed };
      }
      case "work_skill_rollback": {
        const result = this.skills.rollback(this.op(args), {
          skillId: String(args.skill_id), toVersionId: String(args.to_version_id), reason: String(args.reason),
          evidenceRefs: args.evidence_refs as string[] | undefined, approvalRef: String(args.approval_ref), surface: this.surface,
        });
        return { skill_id: String(args.skill_id), active_version_id: String(args.to_version_id), replayed: result.replayed };
      }
      case "work_skill_get":
        return this.skills.getSkill(String(args.skill_id), (args.mode as "normal" | "audit" | undefined) ?? "normal");
      case "work_list":
        return { work: s.list().map(summarize) };
      case "work_route":
        return { matches: s.route(String(args.cue), Number(args.limit ?? 3)) };
      case "work_get": {
        const item = s.getWork(String(args.work_id));
        const recent = Number(args.recent ?? 8);
        const deltas = s.history(item.id).slice(-recent).map((d) => ({
          id: d.id, revision: d.revision, kind: d.kind, summary: d.summary, provenance: d.provenance, created_at: d.createdAt,
        }));
        return { work: summarize(item), branches: item.branches, recent_deltas: recent ? deltas : [] };
      }
      case "work_open": {
        const opened = s.open({
          operationId: this.op(args), topic: String(args.topic), goal: String(args.goal), surface: this.surface,
          instruction: typeof args.instruction === "string" ? args.instruction : undefined,
          initialBranch: branchInput(args.branch),
        });
        return { work: summarize(opened.work) };
      }
      case "work_capture": {
        const captured = s.capture({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          surface: this.surface, kind: args.kind as DeltaKind, summary: String(args.summary),
          provenance: (args.provenance as string[]) ?? [], openLoops: args.open_loops as string[] | undefined,
          nextAction: args.next_action as string | null | undefined,
          branchId: args.branch_id as string | undefined, branch: branchInput(args.branch), ...this.epoch(args),
        });
        return { work: summarize(captured.work), delta: { id: captured.delta.id, revision: captured.delta.revision } };
      }
      case "work_handoff": {
        const target: SurfaceKind = this.surface.kind === "cloud" ? "local" : "cloud";
        const current = s.getWork(String(args.work_id));
        const result = new TrajectaRelay(s, this.surface).handoff({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          summary: String(args.summary), cue: String(args.cue), target,
          provenance: (args.provenance as string[]) ?? [],
          openLoops: (args.open_loops as string[] | undefined) ?? current.openLoops,
          nextAction: args.next_action === undefined ? current.nextAction : (args.next_action as string | null),
          ...this.epoch(args),
        });
        return { work: summarize(result.work), packet: result.packet, receipt: result.receipt };
      }
      case "work_resume": {
        const resumed = s.resume({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          surface: this.surface, instruction: typeof args.instruction === "string" ? args.instruction : undefined, ...this.epoch(args),
        });
        return { work: summarize(resumed.work) };
      }
      case "work_packet":
        return { packet: s.transfer(String(args.work_id), String(args.cue), args.target as SurfaceKind) };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  handle(request: Json): Json | null {
    const id = request.id;
    if (id === undefined || id === null) return null;
    const method = request.method;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const params = (request.params ?? {}) as Json;
      return ok({
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `Work memory for the ${this.surface.kind} surface "${this.surface.name}" (profile ${this.profile.name}). Call work_bootstrap first. Route by cue, then read, capture or hand off with the expected revision.`,
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") {
      const params = (request.params ?? {}) as Json;
      try {
        const result = this.callTool(String(params.name ?? ""), (params.arguments ?? {}) as Json);
        const text = JSON.stringify(result);
        return ok({ content: [{ type: "text", text }], structuredContent: JSON.parse(text), isError: false });
      } catch (error) {
        const message = error instanceof RevisionConflict
          ? `${error.message}. Read the work again (work_get) and retry with revision ${error.latest.revision}.`
          : error instanceof UnsafeInput
            ? `${error.message}. Remove secrets and execution payloads from the arguments.`
            : `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } };
  }
}

export async function runStdio(env: NodeJS.ProcessEnv = process.env) {
  const root = defaultRoot(env);
  const profile = loadProfile(root, env.TRAJECTA_PROFILE?.trim() || undefined);
  const resolveReceipt = receiptResolver(root);
  const store = new TrajectaStore(root, undefined, undefined, { resolveReceipt, admit: claimFence(root) });
  const server = new WorkServer(store, surfaceFrom(env), { profile, resolveReceipt });
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = server.handle(JSON.parse(line));
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
    }
  }
}
