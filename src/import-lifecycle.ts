/**
 * Import an AWM or LWM lifecycle state folder into a Trajecta store.
 *
 * The source is read, never written: `state/lifecycle-events.jsonl` and
 * `state/lifecycle-projection.json` (schema_version 2), plus the optional
 * `config/cue-registry.yaml` one level up. Each source event becomes one
 * Trajecta delta, in order, with the source event id kept in provenance.
 * Operation ids are derived from source ids, so running the import again is
 * a no-op and an interrupted import resumes where it stopped.
 *
 * Phase 1 covers tasks, branches, checkpoints, open loops, next actions and
 * cluster membership. Later phases extend this harness to incidents,
 * chronicle, cases and skills.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalStoreDigest, type TrajectaStore } from "./store.ts";
import { clusterJournal, parseLegacyCueRegistry, type CueRegistry } from "./clusters.ts";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import type { BranchInput, CaptureDeltaInput, DeltaKind, Surface, WorkItem } from "./types.ts";

export type LifecycleSource = "awm" | "lwm";

/**
 * Tasks the source already closed (status complete/abandoned) are not turned
 * into live work items: Trajecta has no verified close yet, and a live item
 * would show up as open work and could be resumed. Their bounded history is
 * kept in the `archived-work` journal instead, until verified close lands.
 */
export interface ArchivedTask extends JournalEvent {
  source: LifecycleSource;
  sourceTaskId: string;
  cluster: string;
  status: string;
  goal: string;
  events: Array<{ eventId: string; kind: string; revision: number; summary: string; provenance: string[]; recordedAt: string }>;
}

export const ARCHIVED_WORK: DomainSpec<{ bySource: Record<string, { status: string; cluster: string; eventId: string }> }, ArchivedTask> = {
  name: "archived-work",
  projectionFile: "archive-index.json",
  projectionSchema: "trajecta.archive-index/v1",
  empty: () => ({ bySource: {} }),
  apply(index, event) {
    index.bySource[`${event.source}:${event.sourceTaskId}`] = { status: event.status, cluster: event.cluster, eventId: event.id };
    return index;
  },
  isEvent: (value: unknown): value is ArchivedTask => {
    const event = value as Partial<ArchivedTask> | null;
    return Boolean(event) && typeof event!.id === "string" && typeof event!.sourceTaskId === "string" && Array.isArray(event!.events);
  },
};

const TERMINAL = new Set(["complete", "abandoned"]);

interface SourceBranch {
  branch_id: string;
  label: string;
  purpose: string;
  cue_terms: string[];
  return_point: string;
  status: string;
}

interface SourceTask {
  task_id: string;
  cluster: string;
  status: string;
  revision: number;
  goal: string;
  current_instruction?: string;
  branches: SourceBranch[];
  open_loops: string[];
  next_action: string | null;
  waiting_on: string | null;
}

interface SourceEvent {
  event_id: string;
  operation_id: string;
  task_id: string;
  session_id: string;
  surface: string;
  cluster: string;
  kind: string;
  summary: string;
  revision: number;
  branch_id?: string;
  provenance_refs: string[];
  recorded_at: string;
}

const DIRECT: Record<string, DeltaKind> = {
  instruction: "instruction", decision: "decision", progress: "progress", blocker: "blocker",
  correction: "correction", branch_open: "branch_open", branch_park: "branch_park", synthesis: "synthesis",
  handoff: "handoff", outcome: "outcome", contract_anchor: "contract_anchor", next_action: "next_action",
};

function readJsonLines(file: string) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function short(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function surfaceOf(source: string, sessionId: string): Surface {
  const local = /(code|codex|local|hermes|cli)/i.test(source);
  return { kind: local ? "local" : "cloud", name: source.slice(0, 120) || "imported", session: (sessionId || "imported").slice(0, 200) };
}

function topicOf(task: SourceTask) {
  const first = task.goal.split(/[.:\n]/)[0].trim() || task.task_id;
  return first.length > 150 ? `${first.slice(0, 147)}...` : first;
}

export interface ImportReport {
  schema: "trajecta.import-report/v1";
  source: LifecycleSource;
  sourceRoot: string;
  sourceDigest: string;
  tasks: Array<{
    sourceTaskId: string;
    workId: string | null;
    archived: boolean;
    cluster: string;
    events: number;
    revision: number;
    sourceRevision: number;
    closedInSource: boolean;
    matches: { openLoops: boolean; nextAction: boolean; goal: boolean };
  }>;
  skipped: Array<{ eventId: string; reason: string }>;
  registry: CueRegistry | null;
}

export function sourceFiles(sourceRoot: string) {
  const state = path.join(sourceRoot, "state");
  return {
    events: path.join(state, "lifecycle-events.jsonl"),
    projection: path.join(state, "lifecycle-projection.json"),
    registry: path.join(sourceRoot, "config", "cue-registry.yaml"),
  };
}

export function importLifecycle(store: TrajectaStore, sourceRoot: string, source: LifecycleSource): ImportReport {
  const files = sourceFiles(path.resolve(sourceRoot));
  if (!fs.existsSync(files.projection)) throw new Error(`No lifecycle projection at ${files.projection}`);
  const projection = JSON.parse(fs.readFileSync(files.projection, "utf8")) as { schema_version: number; tasks: SourceTask[] };
  if (projection.schema_version !== 2 || !Array.isArray(projection.tasks)) throw new Error("Unsupported lifecycle projection (expected schema_version 2)");
  const events = readJsonLines(files.events) as SourceEvent[];
  const registry = fs.existsSync(files.registry) ? parseLegacyCueRegistry(fs.readFileSync(files.registry, "utf8")) : null;
  const sourceDigest = canonicalStoreDigest({ projection, events });
  const clusters = clusterJournal(store.root);
  const report: ImportReport = { schema: "trajecta.import-report/v1", source, sourceRoot: path.resolve(sourceRoot), sourceDigest, tasks: [], skipped: [], registry };
  const op = (kind: string, id: string) => `operation:import-${source}-${kind}-${short(id)}`;

  const archive = new DomainJournal(store.root, ARCHIVED_WORK);

  for (const task of projection.tasks) {
    const taskEvents = events.filter((event) => event.task_id === task.task_id).sort((left, right) => left.revision - right.revision);
    if (TERMINAL.has(task.status)) {
      const kept = taskEvents.slice(-50).map((event) => ({
        eventId: event.event_id, kind: event.kind, revision: event.revision,
        summary: event.summary.slice(0, 1_000), provenance: (event.provenance_refs ?? []).slice(0, 20), recordedAt: event.recorded_at,
      }));
      archive.append(op("archive", task.task_id), { source, taskId: task.task_id, digest: canonicalStoreDigest(kept) }, () => ({
        source, sourceTaskId: task.task_id, cluster: task.cluster, status: task.status, goal: task.goal.slice(0, 1_000), events: kept,
      }));
      report.tasks.push({
        sourceTaskId: task.task_id, workId: null, archived: true, cluster: task.cluster, events: taskEvents.length,
        revision: 0, sourceRevision: task.revision, closedInSource: true,
        matches: { openLoops: true, nextAction: true, goal: true },
      });
      continue;
    }
    const open = taskEvents.find((event) => event.kind === "open");
    // Later "open" events on the same task are resumes (AWM/LWM reopen an
    // exact task id with work_open); only the first one created the task.
    const firstSurface = surfaceOf(open?.surface ?? taskEvents[0]?.surface ?? source, open?.session_id ?? "");
    const opened = store.open({
      operationId: op("open", task.task_id),
      topic: topicOf(task),
      goal: task.goal.slice(0, 1_000),
      surface: firstSurface,
      ...(task.current_instruction ? { instruction: task.current_instruction.slice(0, 1_000) } : {}),
    });
    let work: WorkItem = opened.work;
    const branchIds = new Map<string, string>();
    const anchorIds: string[] = [];
    const rest = taskEvents.filter((event) => event !== open);
    let closed = false;

    rest.forEach((event, position) => {
      const last = position === rest.length - 1;
      const surface = surfaceOf(event.surface, event.session_id);
      if (event.kind === "open") {
        work = store.resume({
          operationId: op("event", event.event_id),
          workId: work.id,
          expectedRevision: work.revision,
          surface,
          instruction: event.summary.slice(0, 1_000),
        }).work;
        return;
      }
      const provenance = [...(event.provenance_refs ?? []), `source:${source}:${event.event_id}`].slice(0, 20);
      let kind: DeltaKind | undefined = DIRECT[event.kind];
      let summary = event.summary;
      let branch: BranchInput | undefined;
      if (event.kind === "branch_open") {
        const described = task.branches.find((item) => item.branch_id === event.branch_id);
        if (described?.cue_terms?.length) {
          branch = { label: described.label, purpose: described.purpose, cues: described.cue_terms, returnPoint: described.return_point };
        } else {
          kind = "progress";
          summary = `[branch opened in source] ${summary}`;
        }
      }
      if (event.kind === "branch_switch") { kind = "progress"; summary = `[branch switch] ${summary}`; }
      if (event.kind === "close") { kind = "outcome"; closed = true; summary = `[closed in source] ${summary}`; }
      if (!kind) { report.skipped.push({ eventId: event.event_id, reason: `unknown kind ${event.kind}` }); return; }
      if (kind === "contract_anchor" && anchorIds.length) provenance.push(anchorIds.at(-1)!);
      const mappedBranch = event.branch_id ? branchIds.get(event.branch_id) : undefined;
      const needsState = kind === "outcome" || last;
      const input: CaptureDeltaInput = {
        operationId: op("event", event.event_id),
        workId: work.id,
        expectedRevision: work.revision,
        surface,
        kind,
        summary: summary.slice(0, kind === "contract_anchor" ? 8_000 : 1_000),
        provenance,
        ...(branch ? { branch } : {}),
        ...(mappedBranch && kind !== "branch_open" ? { branchId: mappedBranch } : {}),
        ...(needsState ? {
          openLoops: last ? [...task.open_loops] : (closed ? [] : [...work.openLoops]),
          nextAction: last ? task.next_action : (closed ? null : work.nextAction),
        } : {}),
      };
      if (kind === "branch_park" && !mappedBranch) {
        report.skipped.push({ eventId: event.event_id, reason: "branch_park for a branch that was not imported" });
        return;
      }
      const result = store.capture(input);
      work = result.work;
      if (kind === "branch_open" && event.branch_id && result.work.activeBranchId) branchIds.set(event.branch_id, result.work.activeBranchId);
      if (kind === "contract_anchor") anchorIds.push(result.delta.id);
    });

    const current = store.getWork(work.id);
    const stateDiffers = JSON.stringify(current.openLoops) !== JSON.stringify(task.open_loops) || current.nextAction !== task.next_action;
    if (stateDiffers && !closed) {
      work = store.capture({
        operationId: op("state", task.task_id),
        workId: work.id,
        expectedRevision: work.revision,
        surface: firstSurface,
        kind: "next_action",
        summary: task.next_action ?? "Open loops carried over from the source",
        provenance: [`source:${source}:${task.task_id}`],
        openLoops: [...task.open_loops],
        nextAction: task.next_action,
      }).work;
    }

    if (task.cluster) {
      clusters.append(op("cluster", `${task.task_id}:${task.cluster}`), { workId: work.id, cluster: task.cluster, source }, () => ({
        type: "assign" as const,
        workId: work.id,
        cluster: task.cluster,
        reason: `imported from ${source} task ${task.task_id}`,
        surface: firstSurface,
      }));
    }
    const final = store.getWork(work.id);
    report.tasks.push({
      sourceTaskId: task.task_id,
      workId: final.id,
      archived: false,
      cluster: task.cluster,
      events: taskEvents.length,
      revision: final.revision,
      sourceRevision: task.revision,
      closedInSource: closed || ["complete", "abandoned"].includes(task.status),
      matches: {
        openLoops: JSON.stringify(final.openLoops) === JSON.stringify(task.open_loops),
        nextAction: final.nextAction === task.next_action,
        goal: final.goal === task.goal.slice(0, 1_000),
      },
    });
  }
  return report;
}
