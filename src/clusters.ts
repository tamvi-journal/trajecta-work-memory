/**
 * Clusters: a routing and organisation layer over work items.
 *
 * A cluster is not part of a work item's identity (decision 2 in
 * docs/specs/2026-09-28-work-layers-from-awm.md). Assignments are append-only
 * events in `cluster-membership.jsonl`; `cluster-index.json` is the
 * rebuildable projection. Re-assigning never changes a work item's revision.
 *
 * The cue registry maps phrases to clusters. Routing is deterministic:
 * primary phrases outrank aliases, aliases outrank detail cues, and ties fall
 * back to clusters that are already active, then to the cluster id.
 */
import fs from "node:fs";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import type { Surface } from "./types.ts";

export const CLUSTER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CueCluster {
  primary: string[];
  aliases: string[];
  detail: string[];
  description?: string;
}

export interface CueRegistry {
  schema: "trajecta.cue-registry/v1";
  maxClusters: number;
  clusters: Record<string, CueCluster>;
}

export function normalizeCue(value: string) {
  return value.toLocaleLowerCase().normalize("NFC").replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
}

function containsPhrase(text: string, phrase: string) {
  if (!phrase) return false;
  return text === phrase || text.startsWith(`${phrase} `) || text.endsWith(` ${phrase}`) || text.includes(` ${phrase} `);
}

export function validateRegistry(value: unknown): CueRegistry {
  const registry = value as Partial<CueRegistry> | null;
  if (!registry || registry.schema !== "trajecta.cue-registry/v1") throw new Error("Cue registry must use schema trajecta.cue-registry/v1");
  const maxClusters = registry.maxClusters ?? 3;
  if (!Number.isInteger(maxClusters) || maxClusters < 1 || maxClusters > 10) throw new Error("maxClusters must be 1..10");
  const clusters: Record<string, CueCluster> = {};
  for (const [id, cluster] of Object.entries(registry.clusters ?? {})) {
    if (!CLUSTER_ID.test(id)) throw new Error(`Invalid cluster id: ${id}`);
    const list = (items: unknown, label: string) => {
      if (items === undefined) return [];
      if (!Array.isArray(items) || items.length > 64 || items.some((item) => typeof item !== "string" || !item.trim() || item.length > 120)) {
        throw new Error(`Cluster ${id}: ${label} must be up to 64 short phrases`);
      }
      return [...new Set(items.map(normalizeCue).filter(Boolean))];
    };
    clusters[id] = {
      primary: list(cluster?.primary, "primary"),
      aliases: list(cluster?.aliases, "aliases"),
      detail: list(cluster?.detail, "detail"),
      ...(typeof cluster?.description === "string" ? { description: cluster.description.slice(0, 500) } : {}),
    };
    if (!clusters[id].primary.length && !clusters[id].aliases.length) throw new Error(`Cluster ${id} needs a primary or alias cue`);
  }
  return { schema: "trajecta.cue-registry/v1", maxClusters, clusters };
}

export function loadRegistry(file: string): CueRegistry {
  return validateRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Read the YAML cue registry used by AWM and LWM (version 0.2). Only the
 * `clusters:` block is read; routing rules outside it are product-specific.
 */
export function parseLegacyCueRegistry(text: string): CueRegistry {
  const lines = text.split(/\r?\n/);
  let version = "";
  let maxClusters = 3;
  const clusters: Record<string, CueCluster> = {};
  let inClusters = false;
  let cluster = "";
  let list: "primary" | "aliases" | "detail" | "" = "";
  for (const line of lines) {
    if (/^version:/.test(line)) version = line.split(":").slice(1).join(":").trim();
    if (/^max_clusters_per_turn:/.test(line)) maxClusters = Number(line.split(":")[1].trim());
    if (line === "clusters:") { inClusters = true; continue; }
    if (/^[A-Za-z_]+:/.test(line)) { inClusters = false; cluster = ""; continue; }
    if (!inClusters) continue;
    const clusterMatch = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (clusterMatch) { cluster = clusterMatch[1]; clusters[cluster] = { primary: [], aliases: [], detail: [] }; list = ""; continue; }
    const listMatch = line.match(/^ {4}(primary|aliases|detail):\s*$/);
    if (listMatch && cluster) { list = listMatch[1] as typeof list; continue; }
    const item = line.match(/^ {6}- (.+)$/);
    if (item && cluster && list) clusters[cluster][list].push(item[1].trim().replace(/^["']|["']$/g, ""));
  }
  if (version !== "0.2") throw new Error("Legacy cue registry must be version 0.2");
  for (const id of Object.keys(clusters)) {
    if (!clusters[id].primary.length && !clusters[id].aliases.length) delete clusters[id];
  }
  return validateRegistry({ schema: "trajecta.cue-registry/v1", maxClusters, clusters });
}

export interface ClusterRoute {
  cluster: string;
  score: number;
  matches: { primary: string[]; aliases: string[]; detail: string[] };
  active: boolean;
}

export function routeClusters(registry: CueRegistry, message: string, activeClusters: string[] = []) {
  const text = normalizeCue(message);
  const considered: ClusterRoute[] = Object.entries(registry.clusters).map(([cluster, cues]) => {
    const primary = cues.primary.filter((cue) => containsPhrase(text, cue));
    // A shorter alias inside a matched primary phrase is not a second match.
    const aliases = cues.aliases.filter((cue) => containsPhrase(text, cue) && !primary.some((exact) => containsPhrase(exact, cue)));
    const hit = primary.length > 0 || aliases.length > 0;
    const detail = hit ? cues.detail.filter((cue) => containsPhrase(text, cue)) : [];
    const active = activeClusters.includes(cluster);
    // Lists hold at most 64 cues, so each class weight dominates every lower
    // class: any primary hit outranks any number of alias-only hits.
    const score = hit ? primary.length * 10_000 + aliases.length * 100 + detail.length : 0;
    return { cluster, score, matches: { primary, aliases, detail }, active };
  });
  const rank = (left: ClusterRoute, right: ClusterRoute) =>
    right.matches.primary.length - left.matches.primary.length
    || right.matches.aliases.length - left.matches.aliases.length
    || right.matches.detail.length - left.matches.detail.length;
  const selected = considered
    .filter((item) => item.score > 0)
    .sort((left, right) => rank(left, right) || Number(right.active) - Number(left.active) || left.cluster.localeCompare(right.cluster))
    .slice(0, registry.maxClusters);
  return {
    normalized: text,
    selected,
    ambiguous: selected.length > 1 && rank(selected[0], selected[1]) === 0 && selected[0].active === selected[1].active,
  };
}

// --- membership journal ---------------------------------------------------

export interface ClusterAssignment extends JournalEvent {
  type: "assign";
  workId: string;
  cluster: string;
  reason: string;
  surface: Surface;
}

export interface ClusterIndex {
  byWork: Record<string, { cluster: string; assignedAt: string; eventId: string }>;
  members: Record<string, string[]>;
}

/** Own-property read, so ids like `constructor` never hit Object.prototype. */
export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function membersOf(index: ClusterIndex, cluster: string): string[] {
  return own(index.members, cluster) ?? [];
}

export function clusterOf(index: ClusterIndex, workId: string): string | null {
  return own(index.byWork, workId)?.cluster ?? null;
}

export function hasCluster(registry: CueRegistry, cluster: string) {
  return Object.hasOwn(registry.clusters, cluster);
}

function isAssignment(value: unknown): value is ClusterAssignment {
  const event = value as Partial<ClusterAssignment> | null;
  return Boolean(event)
    && event!.type === "assign"
    && typeof event!.id === "string"
    && typeof event!.operationId === "string"
    && typeof event!.recordedAt === "string"
    && typeof event!.workId === "string"
    && typeof event!.cluster === "string" && CLUSTER_ID.test(event!.cluster)
    && typeof event!.reason === "string"
    && Boolean(event!.surface) && typeof event!.surface!.kind === "string";
}

export const CLUSTER_MEMBERSHIP: DomainSpec<ClusterIndex, ClusterAssignment> = {
  name: "cluster-membership",
  projectionFile: "cluster-index.json",
  projectionSchema: "trajecta.cluster-index/v1",
  empty: () => ({ byWork: {}, members: {} }),
  apply(index, event) {
    const previous = own(index.byWork, event.workId)?.cluster;
    if (previous) {
      const rest = membersOf(index, previous).filter((id) => id !== event.workId);
      if (rest.length) index.members[previous] = rest;
      else delete index.members[previous];
    }
    index.byWork[event.workId] = { cluster: event.cluster, assignedAt: event.recordedAt, eventId: event.id };
    index.members[event.cluster] = [...membersOf(index, event.cluster).filter((id) => id !== event.workId), event.workId];
    return index;
  },
  isEvent: isAssignment,
};

export function clusterJournal(root: string, clock?: () => Date, fault?: ConstructorParameters<typeof DomainJournal>[3]) {
  return new DomainJournal(root, CLUSTER_MEMBERSHIP, clock, fault);
}
