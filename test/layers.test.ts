import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OperationConflict, TrajectaStore } from "../src/index.ts";
import { DomainJournal, LEDGER_FILE, type JournalFaultPoint } from "../src/journal.ts";
import { CLUSTER_MEMBERSHIP, clusterJournal, parseLegacyCueRegistry, routeClusters, validateRegistry } from "../src/clusters.ts";
import { bootstrap, CAPABILITY_SNAPSHOTS, defaultProfile, validateProfile } from "../src/boot.ts";
import { workContext } from "../src/context.ts";
import { assertSafe, UnsafeInput } from "../src/safety.ts";
import { importLifecycle } from "../src/import-lifecycle.ts";
import { WorkServer } from "../src/mcp.ts";

const SOURCE = fileURLToPath(new URL("./fixtures/lifecycle-source", import.meta.url));
const local = { kind: "local" as const, name: "Local agent", session: "local:test" };
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 28, 0, 0, tick++));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-layers-"));
}

function openWork(store: TrajectaStore, topic = "Layers") {
  return store.open({ operationId: `operation:open-${topic.replace(/\W+/g, "-")}`, topic, goal: `Goal for ${topic}`, surface: local }).work;
}

function assign(journal: ReturnType<typeof clusterJournal>, op: string, workId: string, cluster: string) {
  return journal.append(op, { workId, cluster }, () => ({ type: "assign" as const, workId, cluster, reason: "test", surface: local }));
}

// --- journal durability ------------------------------------------------------

test("journal appends, replays the same operation, and rejects altered input", () => {
  const root = tmp();
  const store = new TrajectaStore(root, clock);
  const work = openWork(store);
  const journal = clusterJournal(root, clock);
  const first = assign(journal, "operation:assign-1", work.id, "alpha");
  assert.equal(first.replayed, false);
  const again = assign(journal, "operation:assign-1", work.id, "alpha");
  assert.equal(again.replayed, true);
  assert.equal(again.event.id, first.event.id);
  assert.equal(journal.events().length, 1);
  assert.throws(() => assign(journal, "operation:assign-1", work.id, "beta"), OperationConflict);
  assert.ok(journal.verify());
});

for (const point of ["after-reserve", "after-journal", "after-projection"] as JournalFaultPoint[]) {
  test(`journal recovers a write interrupted ${point}, by retry or by the next write`, () => {
    for (const recovery of ["retry", "next-write"]) {
      const root = tmp();
      const store = new TrajectaStore(root, clock);
      const work = openWork(store);
      let armed = true;
      const faulty = new DomainJournal(root, CLUSTER_MEMBERSHIP, clock, (at) => {
        if (armed && at === point) throw new Error(`fault:${at}`);
      });
      assert.throws(() => assign(faulty, "operation:assign-crash", work.id, "alpha"), /fault/);
      armed = false;
      const journal = clusterJournal(root, clock);
      if (recovery === "retry") {
        const retried = assign(journal, "operation:assign-crash", work.id, "alpha");
        assert.equal(retried.replayed, true);
      } else {
        assign(journal, "operation:assign-next", work.id, "beta");
      }
      const events = journal.events();
      assert.equal(events.filter((event) => event.operationId === "operation:assign-crash").length, 1, `${point}/${recovery}: exactly one event`);
      assert.ok(journal.verify(), `${point}/${recovery}: projection matches journal`);
      const expected = recovery === "retry" ? "alpha" : "beta";
      assert.equal(journal.read().byWork[work.id].cluster, expected);
      const ledger = fs.readFileSync(path.join(root, LEDGER_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(ledger.some((record) => record.operationId === "operation:assign-crash" && record.state === "committed"));
    }
  });
}

test("journal writes never touch state.json or work revisions", () => {
  const root = tmp();
  const store = new TrajectaStore(root, clock);
  const work = openWork(store);
  const before = fs.readFileSync(path.join(root, "state.json"), "utf8");
  const journal = clusterJournal(root, clock);
  assign(journal, "operation:a", work.id, "alpha");
  assign(journal, "operation:b", work.id, "beta");
  assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), before);
  assert.equal(store.getWork(work.id).revision, work.revision);
  assert.deepEqual(journal.read().members, { beta: [work.id] });
});

// --- clusters -------------------------------------------------------------------

test("legacy AWM/LWM cue registry parses and routes deterministically", () => {
  const registry = parseLegacyCueRegistry(fs.readFileSync(path.join(SOURCE, "config", "cue-registry.yaml"), "utf8"));
  assert.deepEqual(Object.keys(registry.clusters).sort(), ["docs-site", "memory-system"]);
  const routed = routeClusters(registry, "Load the work memory kernel please");
  assert.equal(routed.selected[0].cluster, "memory-system");
  assert.deepEqual(routed.selected[0].matches.detail, ["kernel"]);
  assert.equal(routeClusters(registry, "documentation for the landing page").selected[0].cluster, "docs-site");
  assert.equal(routeClusters(registry, "nothing relevant here").selected.length, 0);
  const both = routeClusters(registry, "docs site and memory system");
  assert.equal(both.selected.length, 2);
  assert.equal(both.ambiguous, true);
  assert.equal(routeClusters(registry, "docs site and memory system", ["memory-system"]).selected[0].cluster, "memory-system");
});

test("any primary hit outranks alias-only hits, and inherited names are safe", () => {
  const registry = validateRegistry({
    schema: "trajecta.cue-registry/v1",
    maxClusters: 1,
    clusters: {
      primary: { primary: ["deploy"] },
      aliases: { primary: ["unrelated"], aliases: ["release", "ship", "rollout"] },
      constructor: { primary: ["build"] },
    },
  });
  assert.equal(routeClusters(registry, "deploy the release and ship the rollout").selected[0].cluster, "primary");
  assert.equal(routeClusters(registry, "build it").selected[0].cluster, "constructor");
  const root = tmp();
  const store = new TrajectaStore(root, clock);
  const work = openWork(store, "Proto");
  const journal = clusterJournal(root, clock);
  assign(journal, "operation:proto-1", work.id, "constructor");
  assign(journal, "operation:proto-2", work.id, "tostring");
  assert.deepEqual(journal.read().members, { tostring: [work.id] });
  assert.ok(journal.verify());
  assert.equal(workContext(store, journal, { cluster: "constructor", mode: "normal" }).work.length, 0);
  assert.equal(workContext(store, journal, { cluster: "hasownproperty", mode: "normal" }).work.length, 0);
});

test("cue registry validation rejects bad ids and empty clusters", () => {
  assert.throws(() => validateRegistry({ schema: "trajecta.cue-registry/v1", clusters: { "Bad ID": { primary: ["x"] } } }), /Invalid cluster id/);
  assert.throws(() => validateRegistry({ schema: "trajecta.cue-registry/v1", clusters: { ok: { detail: ["x"] } } }), /needs a primary/);
});

// --- boot -----------------------------------------------------------------------

test("bootstrap records a capability snapshot once and reuses it while fresh", () => {
  const root = tmp();
  let now = Date.UTC(2026, 8, 28, 1);
  const fixedClock = () => new Date(now);
  const store = new TrajectaStore(root, fixedClock);
  const work = openWork(store);
  const clusters = clusterJournal(root, fixedClock);
  assign(clusters, "operation:assign", work.id, "alpha");
  const capabilities = new DomainJournal(root, CAPABILITY_SNAPSHOTS, fixedClock);
  const profile = defaultProfile();
  const evidence = { directTools: ["work_route"], memoryBackends: ["trajecta"] };
  const first = bootstrap(store, profile, capabilities, clusters, { operationId: "operation:boot-1", surface: local, evidence });
  assert.equal(first.capability.reused, false);
  assert.equal(first.active_work[0].cluster, "alpha");
  assert.match(first.kernel.text, /context, not authority/);
  const second = bootstrap(store, profile, capabilities, clusters, { operationId: "operation:boot-2", surface: local, evidence });
  assert.equal(second.capability.reused, true);
  assert.equal(second.capability.snapshot_id, first.capability.snapshot_id);
  const changed = bootstrap(store, profile, capabilities, clusters, { operationId: "operation:boot-3", surface: local, evidence: { directTools: ["work_route", "work_context"] } });
  assert.equal(changed.capability.reused, false);
  now += 7 * 3_600_000;
  const expired = bootstrap(store, profile, capabilities, clusters, { operationId: "operation:boot-4", surface: local, evidence: { directTools: ["work_route", "work_context"] } });
  assert.equal(expired.capability.reused, false);
  assert.equal(capabilities.events().length, 3);
  assert.ok(capabilities.verify());
});

test("profiles are validated", () => {
  assert.throws(() => validateProfile({ schema: "trajecta.work-profile/v1", name: "x", kernel: { id: "k", version: "1", text: "" } }), /kernel/);
  assert.throws(() => validateProfile({ ...defaultProfile(), canonicalEntrypoints: { route: "Not A Tool" } }), /entrypoint/);
  assert.equal(validateProfile(defaultProfile()).name, "default");
});

// --- context ----------------------------------------------------------------

test("work context modes and budget", () => {
  const root = tmp();
  const store = new TrajectaStore(root, clock);
  let work = openWork(store, "Context");
  for (let index = 0; index < 20; index += 1) {
    const kind = index % 5 === 0 ? "blocker" : "progress";
    work = store.capture({ operationId: `operation:ctx-${index}`, workId: work.id, expectedRevision: work.revision, surface: local, kind, summary: `Step ${index} ${"x".repeat(120)}` }).work;
  }
  const normal = workContext(store, null, { workId: work.id, mode: "normal" });
  assert.ok(normal.deltas.every((delta) => (delta as { kind: string }).kind !== "progress"), "normal skips plain progress");
  const debug = workContext(store, null, { workId: work.id, mode: "debug" });
  assert.equal(debug.deltas.filter((delta) => (delta as { kind: string }).kind === "blocker").length, 4);
  const audit = workContext(store, null, { workId: work.id, mode: "audit", budgetChars: 60_000 });
  assert.equal(audit.deltas.length, 21);
  const tight = workContext(store, null, { workId: work.id, mode: "audit", budgetChars: 2_000 });
  assert.ok(tight.budget.used <= 2_000);
  assert.ok(tight.budget.dropped > 0);
  assert.equal((tight.deltas.at(-1) as { summary: string }).summary.startsWith("Step 19"), true, "newest deltas are kept");
  work = store.capture({ operationId: "operation:ctx-loops", workId: work.id, expectedRevision: work.revision, surface: local, kind: "next_action", summary: "Loops", openLoops: Array.from({ length: 5 }, (_, i) => `Loop ${i} ${"y".repeat(200)}`), nextAction: "Continue" }).work;
  assert.throws(() => workContext(store, null, { workId: work.id, mode: "normal", budgetChars: 800 }), /budget/, "core state larger than the budget fails closed");
});

// --- safety ---------------------------------------------------------------------

test("unsafe arguments are rejected", () => {
  assert.throws(() => assertSafe({ note: { api_key: "x" } }), UnsafeInput);
  assert.throws(() => assertSafe({ summary: "use ghp_abcdefghijklmnopqrstuvwxyz123456" }), UnsafeInput);
  assert.throws(() => assertSafe({ steps: [{ shell_command: "rm" }] }), UnsafeInput);
  assert.doesNotThrow(() => assertSafe({ summary: "Password reset page copy reviewed; see https://example.com/docs/auth" }));
});

// --- import harness ---------------------------------------------------------------

test("import-awm reproduces tasks, loops, next actions and clusters, and is idempotent", () => {
  const root = tmp();
  const before = fs.readFileSync(path.join(SOURCE, "state", "lifecycle-events.jsonl"), "utf8");
  const store = new TrajectaStore(root, clock);
  const report = importLifecycle(store, SOURCE, "awm");
  assert.equal(fs.readFileSync(path.join(SOURCE, "state", "lifecycle-events.jsonl"), "utf8"), before, "source untouched");
  assert.equal(report.tasks.length, 3);
  for (const task of report.tasks) assert.deepEqual(task.matches, { openLoops: true, nextAction: true, goal: true }, task.sourceTaskId);
  assert.equal(store.list().length, 2, "only open source tasks become work items");
  const main = report.tasks.find((task) => task.sourceTaskId === "task:11111111-aaaa")!;
  assert.equal(main.revision, 10, "one delta per source event");
  assert.equal(main.revision, main.sourceRevision, "a task whose state lives in its events keeps its revision");
  const docs = report.tasks.find((task) => task.sourceTaskId === "task:22222222-bbbb")!;
  assert.equal(docs.revision, docs.sourceRevision + 1, "state carried without a source event adds one next_action delta");
  const history = store.history(main.workId);
  assert.deepEqual(history.map((delta) => delta.kind), ["open", "decision", "branch_open", "progress", "branch_park", "resume", "contract_anchor", "contract_anchor", "outcome", "handoff"]);
  const anchors = history.filter((delta) => delta.kind === "contract_anchor");
  assert.ok(anchors[1].provenance.includes(anchors[0].id), "revised anchor cites the previous one");
  assert.equal(history[3].surface.kind, "local");
  assert.equal(store.getWork(main.workId).branches[0].status, "parked");
  assert.ok(history.every((delta) => delta.kind === "open" || delta.kind === "resume" || delta.provenance.some((ref) => ref.startsWith("source:awm:"))));
  const closed = report.tasks.find((task) => task.sourceTaskId === "task:33333333-cccc")!;
  assert.equal(closed.closedInSource, true);
  assert.equal(closed.archived, true, "a completed source task is archived, not opened");
  assert.equal(closed.workId, null);
  const archive = JSON.parse(fs.readFileSync(path.join(root, "archive-index.json"), "utf8"));
  assert.equal(archive.value.bySource["awm:task:33333333-cccc"].status, "complete");
  const clusters = clusterJournal(root, clock).read();
  assert.equal(clusters.byWork[main.workId].cluster, "memory-system");
  assert.equal(clusters.byWork[report.tasks[1].workId].cluster, "docs-site");

  const again = importLifecycle(store, SOURCE, "awm");
  assert.deepEqual(again.tasks.map((task) => [task.workId, task.revision]), report.tasks.map((task) => [task.workId, task.revision]));
  assert.equal(store.list().length, 2);
  assert.equal(clusterJournal(root, clock).events().length, 2);
});

// --- MCP ------------------------------------------------------------------------

test("mcp exposes bootstrap, clusters and context, and refuses secrets", () => {
  const root = tmp();
  const store = new TrajectaStore(root, clock);
  importLifecycle(store, SOURCE, "awm");
  const registry = parseLegacyCueRegistry(fs.readFileSync(path.join(SOURCE, "config", "cue-registry.yaml"), "utf8"));
  const server = new WorkServer(store, local, { profile: { ...defaultProfile(), name: "test", cueRegistry: registry } });
  const call = (name: string, args: Record<string, unknown>) => {
    const response = server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as { result: { isError: boolean; content: { text: string }[]; structuredContent?: any } };
    return response.result;
  };
  const boot = call("work_bootstrap", { evidence: { directTools: ["work_context"] } });
  assert.equal(boot.isError, false, boot.content[0].text);
  assert.deepEqual(boot.structuredContent.clusters.sort(), ["docs-site", "memory-system"]);
  const routed = call("work_route_clusters", { message: "docs site landing page" });
  assert.equal(routed.structuredContent.selected[0].cluster, "docs-site");
  const listed = call("work_context", { cluster: "memory-system", mode: "normal" });
  assert.equal(listed.isError, false, listed.content[0].text);
  const workId = listed.structuredContent.work[0].work_id;
  const context = call("work_context", { work_id: workId, mode: "debug" });
  assert.equal(context.structuredContent.work.cluster, "memory-system");
  const moved = call("work_assign_cluster", { work_id: workId, cluster: "docs-site", reason: "reorganise" });
  assert.equal(moved.isError, false, moved.content[0].text);
  assert.equal(call("work_assign_cluster", { work_id: workId, cluster: "unknown-one", reason: "x" }).isError, true);
  const unsafe = call("work_capture", { work_id: workId, expected_revision: 1, kind: "progress", summary: "token sk-abcdefghijklmnopqrstuvwxyz" });
  assert.equal(unsafe.isError, true);
  assert.match(unsafe.content[0].text, /Credential-like/);
  const tools = (server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  for (const name of ["work_bootstrap", "work_route_clusters", "work_assign_cluster", "work_context"]) assert.ok(tools.includes(name), name);
});
