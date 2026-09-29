/**
 * Bounded work context with explicit modes.
 *
 * - normal: the work item, its active branch, and recent material deltas.
 * - debug:  normal, plus every blocker and correction on the item.
 * - audit:  the full delta history.
 *
 * Every answer fits the caller's character budget. Older deltas are dropped
 * first; if the core state alone does not fit, the call fails instead of
 * returning a cut-off record. Later phases add prevention rules and lessons
 * (normal), incident summaries (debug) and raw incidents/chronicle (audit).
 */
import type { TrajectaStore } from "./store.ts";
import type { DomainJournal } from "./journal.ts";
import { clusterOf, membersOf, type ClusterAssignment, type ClusterIndex } from "./clusters.ts";
import type { LearningLayer } from "./learning.ts";
import type { CaseLayer } from "./cases.ts";
import type { SkillLayer } from "./skills.ts";
import type { Delta } from "./types.ts";

export type ContextMode = "normal" | "debug" | "audit";

const NORMAL_KINDS = new Set(["open", "instruction", "decision", "blocker", "correction", "next_action", "synthesis", "handoff", "outcome", "resume", "branch_open", "branch_park"]);

export interface ContextInput {
  workId?: string;
  cluster?: string;
  mode: ContextMode;
  budgetChars?: number;
}

function compactDelta(delta: Delta) {
  return {
    id: delta.id, revision: delta.revision, kind: delta.kind, summary: delta.summary, provenance: delta.provenance, created_at: delta.createdAt,
    ...(delta.contractVersion !== undefined ? { contract_version: delta.contractVersion, previous_contract_id: delta.previousContractId ?? null } : {}),
  };
}

interface Budget { chars: number; used: number; dropped: number }
const size = (value: unknown) => JSON.stringify(value).length;

/**
 * Write the real serialized size into budget.used. Changing `used` changes
 * the size (more digits), so repeat until the number describes itself.
 */
function settle(result: { budget: Budget }) {
  for (let round = 0; round < 8; round += 1) {
    const measured = size(result);
    if (result.budget.used === measured) return measured;
    result.budget.used = measured;
  }
  return size(result);
}

/**
 * Keep as many items as fit, dropping from `dropFrom` first, and only return
 * a response whose final serialized size (budget.used included) is within
 * the budget. Fails closed when nothing but the core state is left and it
 * still does not fit.
 */
function fitList<T extends { budget: Budget }>(make: (kept: unknown[], dropped: number) => T, items: unknown[], budget: number, dropFrom: "start" | "end"): T {
  const kept = [...items];
  for (;;) {
    const result = make(kept, items.length - kept.length);
    if (settle(result) <= budget) return result;
    if (!kept.length) throw new Error("Work context exceeds the character budget; raise budget_chars or narrow the request");
    if (dropFrom === "start") kept.shift(); else kept.pop();
  }
}

export function workContext(
  store: TrajectaStore,
  clusters: DomainJournal<ClusterIndex, ClusterAssignment> | null,
  input: ContextInput,
  learning: LearningLayer | null = null,
  investigation: { cases?: CaseLayer; skills?: SkillLayer } | null = null,
) {
  const budget = input.budgetChars ?? 6_000;
  if (!Number.isInteger(budget) || budget < 800 || budget > 60_000) throw new Error("budget_chars must be an integer in 800..60000");
  if (!["normal", "debug", "audit"].includes(input.mode)) throw new Error("mode must be normal, debug or audit");
  const index = clusters?.read() ?? { byWork: {}, members: {} };

  if (!input.workId) {
    if (!input.cluster) throw new Error("Give a work_id, or a cluster to list");
    const members = new Set(membersOf(index, input.cluster));
    const work = store.list()
      .filter((item) => members.has(item.id) && (input.mode === "audit" || !["complete", "abandoned"].includes(item.status)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => ({ work_id: item.id, topic: item.topic, status: item.status, revision: item.revision, next_action: item.nextAction, updated_at: item.updatedAt }));
    return fitList((kept, dropped) => ({
      schema: "trajecta.context/v1", mode: input.mode, cluster: input.cluster, work: kept, deltas: [] as unknown[],
      budget: { chars: budget, used: 0, dropped },
    }), work, budget, "end");
  }

  const item = store.getWork(input.workId);
  const branch = item.branches.find((candidate) => candidate.id === item.activeBranchId) ?? null;
  const history = store.history(item.id);
  const anchor = history.filter((delta) => delta.kind === "contract_anchor").at(-1);
  const selected = history.filter((delta) => {
    if (input.mode === "audit") return true; // full history, contract anchors included
    if (delta.kind === "contract_anchor") return false; // summarised in contract_anchor below
    if (input.mode === "debug" && (delta.kind === "blocker" || delta.kind === "correction")) return true;
    return NORMAL_KINDS.has(delta.kind);
  });
  const recent = input.mode === "normal" ? selected.slice(-12) : selected;
  const base = {
    schema: "trajecta.context/v1",
    mode: input.mode,
    work: {
      work_id: item.id,
      topic: item.topic,
      goal: item.goal,
      instruction: item.instruction,
      status: item.status,
      revision: item.revision,
      cluster: clusterOf(index, item.id),
      open_loops: item.openLoops,
      next_action: item.nextAction,
      last_surface: item.lastSurface,
      updated_at: item.updatedAt,
      ...(item.pendingHandoff ? { pending_handoff: { from_actor: item.pendingHandoff.fromActor, to_actor: item.pendingHandoff.toActor, to_surface: item.pendingHandoff.toSurfaceKind, revision: item.pendingHandoff.revision } } : {}),
    },
    active_branch: branch ? { id: branch.id, label: branch.label, purpose: branch.purpose, return_point: branch.returnPoint } : null,
    contract_anchor: anchor ? { id: anchor.id, version: anchor.contractVersion, summary: anchor.summary, provenance: anchor.provenance, created_at: anchor.createdAt } : null,
    resume_rule: `Resume only ${item.id} at revision ${item.revision}. Memory is context, not authority.`,
    deltas: [] as unknown[],
  };
  // Learning layer: accepted rules in every mode; incident summaries in
  // debug; raw incidents and chronicle in audit. Candidates are never rules.
  const workCluster = clusterOf(index, item.id);
  const learned = learning ? {
    prevention_rules: learning.rulesFor(workCluster).map((rule) => ({ id: rule.invariantId, rule: rule.rule, approval_ref: rule.approvalRef })),
    ...(input.mode === "debug" ? { incident_summaries: learning.incidentSummaries({ workId: item.id, cluster: workCluster }) } : {}),
    ...(input.mode === "audit" ? (() => {
      const trail = learning.auditTrail(item.id, workCluster);
      return {
        incidents: trail.incidents.map((incident) => ({
          id: incident.id, kind: incident.kind, summary: incident.summary, violated_invariant: incident.violatedInvariant,
          evidence_refs: incident.evidenceRefs, correction: incident.correction, prevention_rule: incident.preventionRule,
          tier: incident.tier, recorded_at: incident.recordedAt,
        })),
        chronicle: trail.chronicle.map((milestone) => ({ id: milestone.id, stage: milestone.stage, summary: milestone.summary, provenance: milestone.provenance, recorded_at: milestone.recordedAt })),
      };
    })() : {}),
  } : {};
  Object.assign(base, learned);
  // Investigation layer: linked cases and active skills in every mode;
  // hypotheses in debug; full hypotheses and case events in audit. Skill
  // candidates never appear here.
  if (investigation?.skills) Object.assign(base, { active_skills: investigation.skills.activeFor(workCluster) });
  if (investigation?.cases) {
    const cases = investigation.cases.linkedCases(item.id);
    Object.assign(base, {
      linked_cases: cases.map(([caseId, record]) => ({
        case_id: caseId, title: record.title, status: record.status, incident_ids: record.incidentIds,
        resolution_hypothesis_ids: record.resolutionHypothesisIds,
        ...(input.mode === "normal" ? {} : {
          hypotheses: investigation.cases!.hypothesesOf(caseId).map(([hypothesisId, hypothesis]) => ({
            id: hypothesisId, status: hypothesis.status, statement: hypothesis.statement, attestation: hypothesis.attestation,
            ...(input.mode === "audit" ? {
              verification_ref: hypothesis.verificationRef, supporting_refs: hypothesis.supportingRefs,
              disconfirming_refs: hypothesis.disconfirmingRefs, author: hypothesis.author,
            } : {}),
          })),
        }),
      })),
      ...(input.mode === "audit" ? {
        case_events: investigation.cases.journal.events()
          .filter((event) => event.type !== "hypothesis" && cases.some(([caseId]) => caseId === event.caseId))
          .slice(-50),
      } : {}),
    });
  }
  const { deltas: _none, ...fixed } = base;
  return fitList((kept, dropped) => ({ ...fixed, deltas: kept, budget: { chars: budget, used: 0, dropped } }), recent.map(compactDelta), budget, "start");
}
