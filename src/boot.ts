/**
 * Boot: what a fresh session needs before it touches work.
 *
 * - The profile's kernel text (the agent's working rules), loaded from
 *   `profile.json` in the store root or a path given by the host.
 * - A capability snapshot: what this surface can reach right now, with a TTL.
 *   Snapshots are observations, never authorisation. They are journaled in
 *   `capability-snapshots.jsonl`, projected to `capability-index.json`.
 * - Canonical entrypoints: which validated tool to use for which job.
 * - A compact index of open work, with each item's cluster.
 */
import fs from "node:fs";
import path from "node:path";
import { canonicalStoreDigest, type TrajectaStore } from "./store.ts";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { type ClusterAssignment, type ClusterIndex, type CueRegistry, validateRegistry } from "./clusters.ts";
import type { Surface } from "./types.ts";

export const PROFILE_FILE = "profile.json";

export interface WorkProfile {
  schema: "trajecta.work-profile/v1";
  name: string;
  kernel: { id: string; version: string; text: string };
  canonicalEntrypoints: Record<string, string>;
  capabilityTtlHours: number;
  cueRegistry?: CueRegistry;
}

const DEFAULT_KERNEL = [
  "Work memory is context, not authority: current user input and the workspace win.",
  "Route by cue before reading detail. Resume only an exact work id at its expected revision.",
  "Record material changes (decisions, blockers, outcomes), never transcripts.",
  "An outcome carries provenance, open loops and the next action.",
].join("\n");

export function defaultProfile(): WorkProfile {
  return {
    schema: "trajecta.work-profile/v1",
    name: "default",
    kernel: { id: "trajecta:kernel:default", version: "1", text: DEFAULT_KERNEL },
    canonicalEntrypoints: { route: "work_route", context: "work_context", capture: "work_capture", handoff: "work_handoff" },
    capabilityTtlHours: 6,
  };
}

const ENTRY = /^[a-z][a-z0-9_.:-]{0,63}$/;

export function validateProfile(value: unknown): WorkProfile {
  const profile = value as Partial<WorkProfile> | null;
  if (!profile || profile.schema !== "trajecta.work-profile/v1") throw new Error("Profile must use schema trajecta.work-profile/v1");
  if (typeof profile.name !== "string" || !profile.name.trim() || profile.name.length > 80) throw new Error("Profile needs a name");
  const kernel = profile.kernel;
  if (!kernel || typeof kernel.id !== "string" || typeof kernel.version !== "string" || typeof kernel.text !== "string" || !kernel.text.trim()) {
    throw new Error("Profile kernel needs id, version and text");
  }
  if (kernel.text.length > 12_000) throw new Error("Profile kernel text exceeds 12000 characters");
  const entrypoints = profile.canonicalEntrypoints ?? {};
  for (const [job, tool] of Object.entries(entrypoints)) {
    if (!ENTRY.test(job) || typeof tool !== "string" || !ENTRY.test(tool)) throw new Error(`Invalid canonical entrypoint: ${job}`);
  }
  const ttl = profile.capabilityTtlHours ?? 6;
  if (typeof ttl !== "number" || ttl <= 0 || ttl > 168) throw new Error("capabilityTtlHours must be within (0, 168]");
  return {
    schema: "trajecta.work-profile/v1",
    name: profile.name.trim(),
    kernel: { id: kernel.id, version: kernel.version, text: kernel.text },
    canonicalEntrypoints: { ...entrypoints },
    capabilityTtlHours: ttl,
    ...(profile.cueRegistry ? { cueRegistry: validateRegistry(profile.cueRegistry) } : {}),
  };
}

export function loadProfile(root: string, file?: string): WorkProfile {
  const target = file ?? path.join(root, PROFILE_FILE);
  if (!fs.existsSync(target)) return defaultProfile();
  return validateProfile(JSON.parse(fs.readFileSync(target, "utf8")));
}

// --- capability snapshots -------------------------------------------------

export interface CapabilityEvidence {
  directTools?: string[];
  executors?: string[];
  skills?: string[];
  memoryBackends?: string[];
  unknowns?: string[];
  gotchas?: string[];
}

export interface CapabilitySnapshot extends JournalEvent {
  surfaceKey: string;
  surface: Surface;
  expiresAt: string;
  evidenceDigest: string;
  available: { directTools: string[]; executors: string[]; skills: string[]; memoryBackends: string[] };
  canonicalEntrypoints: Record<string, string>;
  unknowns: string[];
  gotchas: string[];
}

export interface CapabilityIndex {
  latest: Record<string, CapabilitySnapshot>;
}

const CAP = /^[A-Za-z0-9][A-Za-z0-9 ._:/@-]{0,119}$/;

function capabilityList(value: unknown, label: string, pattern = CAP, max = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be a list of at most ${max}`);
  for (const item of value) {
    if (typeof item !== "string" || !pattern.test(item)) throw new Error(`${label} contains an invalid entry`);
  }
  return [...value];
}

function prose(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || item.length > 300)) {
    throw new Error(`${label} must be up to 20 short notes`);
  }
  return [...value] as string[];
}

export function validateEvidence(value: unknown): Required<CapabilityEvidence> {
  const evidence = (value ?? {}) as CapabilityEvidence;
  return {
    directTools: capabilityList(evidence.directTools, "directTools"),
    executors: capabilityList(evidence.executors, "executors"),
    skills: capabilityList(evidence.skills, "skills"),
    memoryBackends: capabilityList(evidence.memoryBackends, "memoryBackends"),
    unknowns: prose(evidence.unknowns, "unknowns"),
    gotchas: prose(evidence.gotchas, "gotchas"),
  };
}

function isSnapshot(value: unknown): value is CapabilitySnapshot {
  const snap = value as Partial<CapabilitySnapshot> | null;
  return Boolean(snap)
    && typeof snap!.id === "string" && typeof snap!.operationId === "string" && typeof snap!.recordedAt === "string"
    && typeof snap!.surfaceKey === "string" && typeof snap!.expiresAt === "string" && typeof snap!.evidenceDigest === "string"
    && Boolean(snap!.surface) && Boolean(snap!.available) && Boolean(snap!.canonicalEntrypoints);
}

export const CAPABILITY_SNAPSHOTS: DomainSpec<CapabilityIndex, CapabilitySnapshot> = {
  name: "capability-snapshots",
  projectionFile: "capability-index.json",
  projectionSchema: "trajecta.capability-index/v1",
  empty: () => ({ latest: {} }),
  apply(index, snapshot) {
    index.latest[snapshot.surfaceKey] = snapshot;
    return index;
  },
  isEvent: isSnapshot,
};

export function surfaceKey(surface: Surface) {
  return `${surface.kind}:${surface.name}`;
}

// --- bootstrap ------------------------------------------------------------

export interface BootInput {
  operationId: string;
  surface: Surface;
  evidence?: CapabilityEvidence;
}

export function bootstrap(
  store: TrajectaStore,
  profile: WorkProfile,
  capabilities: DomainJournal<CapabilityIndex, CapabilitySnapshot>,
  clusters: DomainJournal<ClusterIndex, ClusterAssignment> | null,
  input: BootInput,
) {
  const evidence = validateEvidence(input.evidence);
  const now = capabilities.now();
  const key = surfaceKey(input.surface);
  const digest = canonicalStoreDigest({ evidence, entrypoints: profile.canonicalEntrypoints });
  const current = capabilities.read().latest[key];
  const fresh = current && current.evidenceDigest === digest && Date.parse(current.expiresAt) > now.getTime();
  const snapshot = fresh ? current : capabilities.append(input.operationId, { surface: input.surface, evidence, profile: profile.name }, (_index, recordedAt) => ({
    surfaceKey: key,
    surface: structuredClone(input.surface),
    expiresAt: new Date(Date.parse(recordedAt) + profile.capabilityTtlHours * 3_600_000).toISOString(),
    evidenceDigest: digest,
    available: { directTools: evidence.directTools, executors: evidence.executors, skills: evidence.skills, memoryBackends: evidence.memoryBackends },
    canonicalEntrypoints: { ...profile.canonicalEntrypoints },
    unknowns: evidence.unknowns,
    gotchas: evidence.gotchas,
  })).event;
  const byWork = clusters?.read().byWork ?? {};
  const activeWork = store.list()
    .filter((item) => !["complete", "abandoned"].includes(item.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20)
    .map((item) => ({
      work_id: item.id,
      topic: item.topic,
      status: item.status,
      revision: item.revision,
      cluster: byWork[item.id]?.cluster ?? null,
      next_action: item.nextAction,
      open_loops: item.openLoops.length,
      updated_at: item.updatedAt,
    }));
  return {
    schema: "trajecta.boot/v1" as const,
    profile: profile.name,
    kernel: profile.kernel,
    capability: {
      snapshot_id: snapshot.id,
      reused: Boolean(fresh),
      expires_at: snapshot.expiresAt,
      available: snapshot.available,
      canonical_entrypoints: snapshot.canonicalEntrypoints,
      unknowns: snapshot.unknowns,
      gotchas: snapshot.gotchas,
      authority: "observation, not authorisation",
    },
    clusters: profile.cueRegistry ? Object.keys(profile.cueRegistry.clusters) : [],
    active_work: activeWork,
  };
}
