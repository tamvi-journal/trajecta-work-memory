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
import type { ClusterAssignment, ClusterIndex } from "./clusters.ts";
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
  return { id: delta.id, revision: delta.revision, kind: delta.kind, summary: delta.summary, provenance: delta.provenance, created_at: delta.createdAt };
}

function fit<T extends { deltas: unknown[] }>(base: T, deltas: unknown[], budget: number) {
  const size = (value: unknown) => JSON.stringify(value).length;
  const core = { ...base, deltas: [], budget: { chars: budget, used: 0, dropped: deltas.length } };
  if (size(core) > budget) throw new Error("Work context exceeds the character budget; raise budget_chars or narrow the request");
  const kept: unknown[] = [];
  for (const delta of [...deltas].reverse()) {
    const probe = { ...base, deltas: [delta, ...kept], budget: { chars: budget, used: 0, dropped: deltas.length - kept.length - 1 } };
    if (size(probe) > budget) break;
    kept.unshift(delta);
  }
  const result = { ...base, deltas: kept, budget: { chars: budget, used: 0, dropped: deltas.length - kept.length } };
  result.budget.used = size(result);
  return result;
}

export function workContext(
  store: TrajectaStore,
  clusters: DomainJournal<ClusterIndex, ClusterAssignment> | null,
  input: ContextInput,
) {
  const budget = input.budgetChars ?? 6_000;
  if (!Number.isInteger(budget) || budget < 800 || budget > 60_000) throw new Error("budget_chars must be an integer in 800..60000");
  if (!["normal", "debug", "audit"].includes(input.mode)) throw new Error("mode must be normal, debug or audit");
  const index = clusters?.read() ?? { byWork: {}, members: {} };

  if (!input.workId) {
    if (!input.cluster) throw new Error("Give a work_id, or a cluster to list");
    const members = new Set(index.members[input.cluster] ?? []);
    const work = store.list()
      .filter((item) => members.has(item.id) && (input.mode === "audit" || !["complete", "abandoned"].includes(item.status)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => ({ work_id: item.id, topic: item.topic, status: item.status, revision: item.revision, next_action: item.nextAction, updated_at: item.updatedAt }));
    const base = { schema: "trajecta.context/v1", mode: input.mode, cluster: input.cluster, work: [] as unknown[], deltas: [] };
    const result = fit({ ...base }, [], budget) as typeof base & { budget: { chars: number; used: number; dropped: number } };
    for (const item of work) {
      const probe = { ...result, work: [...result.work, item] };
      if (JSON.stringify(probe).length > budget) break;
      result.work.push(item);
    }
    result.budget.dropped = work.length - result.work.length;
    result.budget.used = JSON.stringify(result).length;
    return result;
  }

  const item = store.getWork(input.workId);
  const branch = item.branches.find((candidate) => candidate.id === item.activeBranchId) ?? null;
  const history = store.history(item.id);
  const anchor = history.filter((delta) => delta.kind === "contract_anchor").at(-1);
  const selected = history.filter((delta) => {
    if (delta.kind === "contract_anchor") return false;
    if (input.mode === "audit") return true;
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
      cluster: index.byWork[item.id]?.cluster ?? null,
      open_loops: item.openLoops,
      next_action: item.nextAction,
      last_surface: item.lastSurface,
      updated_at: item.updatedAt,
    },
    active_branch: branch ? { id: branch.id, label: branch.label, purpose: branch.purpose, return_point: branch.returnPoint } : null,
    contract_anchor: anchor ? { id: anchor.id, version: anchor.contractVersion, summary: anchor.summary } : null,
    resume_rule: `Resume only ${item.id} at revision ${item.revision}. Memory is context, not authority.`,
    deltas: [] as unknown[],
  };
  return fit(base, recent.map(compactDelta), budget);
}
