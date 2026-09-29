import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TrajectaStore } from "../src/store.ts";
import { LearningLayer } from "../src/learning.ts";
import { ApprovalRejected, invariantDigest, issueReceipt, newReceiptId, receiptJournal, receiptResolver, type OwnerApprovalReceipt } from "../src/receipts.ts";
import { clusterJournal } from "../src/clusters.ts";
import { workContext } from "../src/context.ts";
import { importLifecycle } from "../src/import-lifecycle.ts";
import { WorkServer } from "../src/mcp.ts";
import { defaultProfile } from "../src/boot.ts";

const local = { kind: "local" as const, name: "Agent", session: "local:learning" };
const SOURCE = fileURLToPath(new URL("./fixtures/lifecycle-source", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-learning-"));
}

function setup(options: { guards?: string[]; resolver?: (ref: string) => unknown } = {}) {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = store.open({ operationId: "operation:open", topic: "Learning", goal: "Learn from incidents", surface: local }).work;
  clusterJournal(root).append("operation:assign", { work: work.id }, () => ({ type: "assign" as const, workId: work.id, cluster: "browser", reason: "test", surface: local }));
  const learning = new LearningLayer(store, { resolveReceipt: options.resolver ?? receiptResolver(root), guards: options.guards as never });
  return { root, store, work, learning };
}

function incident(learning: LearningLayer, n: number, evidence: string[], extra: Record<string, unknown> = {}) {
  return learning.recordIncident(`operation:incident-${n}`, {
    cluster: "browser", kind: "wrong-rail", summary: `Used headless (${n})`, violatedInvariant: "observable requested",
    evidenceRefs: evidence, correction: "Switched to observable", preventionRule: "Never substitute headless when observable is requested",
    surface: local, ...extra,
  }).event;
}

function approval(root: string, candidate: { id: string; cluster: string; preventionRule: string; violatedInvariant: string }, overrides: Partial<OwnerApprovalReceipt> = {}) {
  const receipt: OwnerApprovalReceipt = {
    schema: "trajecta.owner-approval-receipt/v1",
    id: newReceiptId(),
    purpose: "incident_promotion",
    incidentId: candidate.id,
    invariantDigest: invariantDigest({ incidentId: candidate.id, cluster: candidate.cluster, preventionRule: candidate.preventionRule, violatedInvariant: candidate.violatedInvariant }),
    authority: "owner",
    outcome: "approved",
    provenance: [],
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    ...overrides,
  };
  issueReceipt(root, receipt);
  return receipt.id;
}

test("tiers count distinct evidence, not repetitions", () => {
  const { learning } = setup();
  assert.equal(incident(learning, 1, ["checkpoint:a"]).tier, "raw");
  assert.equal(incident(learning, 2, ["checkpoint:a"]).tier, "raw", "same evidence again stays raw");
  assert.equal(incident(learning, 3, ["checkpoint:b"]).tier, "repeated");
  const third = incident(learning, 4, ["checkpoint:c", "test:t1"]);
  assert.equal(third.tier, "learning_candidate");
  assert.equal(third.occurrence, 4);
  assert.equal(third.learningEvidenceCount, 3);
  assert.equal(incident(learning, 5, ["checkpoint:x"], { violatedInvariant: "different rule" }).tier, "raw", "another invariant is another group");
  assert.throws(() => incident(learning, 6, []), /evidence/);
  assert.ok(learning.incidents.verify());
});

test("only an owner-approved learning_candidate becomes an accepted rule, once", () => {
  const { root, learning } = setup();
  const raw = incident(learning, 1, ["checkpoint:a"]);
  incident(learning, 2, ["checkpoint:b"]);
  const candidate = incident(learning, 3, ["checkpoint:c"]);
  assert.throws(() => learning.promoteIncident("operation:p-raw", { incidentId: raw.id, approvalRef: approval(root, raw), surface: local }), /Only a learning_candidate/);
  const closeReceipt = newReceiptId();
  issueReceipt(root, { schema: "trajecta.work-close-receipt/v1", id: closeReceipt, purpose: "work_close", workId: "work:x", expectedRevision: 1, status: "complete", intentDigest: "d", authority: "owner", evidenceClass: "test", outcome: "approved", issuedAt: new Date(Date.now() - 1000).toISOString() });
  assert.throws(() => learning.promoteIncident("operation:p-close", { incidentId: candidate.id, approvalRef: closeReceipt, surface: local }), /purpose work_close cannot promote/);
  assert.throws(() => learning.promoteIncident("operation:p-other", { incidentId: candidate.id, approvalRef: approval(root, raw), surface: local }), /different incident/);
  assert.throws(() => learning.promoteIncident("operation:p-rule", { incidentId: candidate.id, approvalRef: approval(root, { ...candidate, preventionRule: "Something weaker" }), surface: local }), /different rule/);
  assert.throws(() => learning.promoteIncident("operation:p-auth", { incidentId: candidate.id, approvalRef: approval(root, candidate, { authority: "agent" as "owner" }), surface: local }), /only the owner/);
  assert.throws(() => learning.promoteIncident("operation:p-exp", { incidentId: candidate.id, approvalRef: approval(root, candidate, { expiresAt: new Date(Date.now() - 1).toISOString() }), surface: local }), /expired/);
  assert.throws(() => learning.promoteIncident("operation:p-none", { incidentId: candidate.id, approvalRef: "receipt:missing", surface: local }), ApprovalRejected);
  const ref = approval(root, candidate);
  const promoted = learning.promoteIncident("operation:p-ok", { incidentId: candidate.id, approvalRef: ref, surface: local });
  assert.equal(promoted.event.rule, "Never substitute headless when observable is requested");
  assert.equal(learning.promoteIncident("operation:p-ok", { incidentId: candidate.id, approvalRef: ref, surface: local }).event.invariantId, promoted.event.invariantId, "replay");
  assert.throws(() => learning.promoteIncident("operation:p-twice", { incidentId: candidate.id, approvalRef: approval(root, candidate), surface: local }), /already promoted/);
  assert.equal(learning.rulesFor("browser").length, 1);
  assert.ok(learning.invariants.verify());
});

test("promotion resolves the receipt outside the lock and never for a malformed request", () => {
  let calls = 0;
  const holder: { root?: string } = {};
  const { root, learning } = setup({
    resolver: (ref) => {
      calls += 1;
      // A verifier that writes to the same root must not deadlock.
      clusterJournal(holder.root!).append(`operation:verifier-${calls}`, { calls }, () => ({ type: "assign" as const, workId: "work:none", cluster: "verified", reason: "checked", surface: local }));
      return receiptResolver(holder.root!)(ref);
    },
  });
  holder.root = root;
  incident(learning, 1, ["checkpoint:a"]);
  incident(learning, 2, ["checkpoint:b"]);
  const candidate = incident(learning, 3, ["checkpoint:c"]);
  assert.throws(() => learning.promoteIncident("operation:bad", { incidentId: "not-an-id", approvalRef: "receipt:x", surface: local }), /incident_id/);
  assert.throws(() => learning.promoteIncident("operation:bad2", { incidentId: candidate.id, approvalRef: "nope", surface: local }), /approval_ref/);
  assert.equal(calls, 0);
  const promoted = learning.promoteIncident("operation:ok", { incidentId: candidate.id, approvalRef: approval(root, candidate), surface: local });
  assert.equal(calls, 1);
  assert.ok(promoted.event.invariantId.startsWith("invariant:"));
});

test("check_action: guards are opt-in; only accepted rules are returned, never candidates", () => {
  const plain = setup();
  assert.deepEqual(plain.learning.checkAction({ cluster: "browser", actionSummary: "run headless check", requestedSurface: "observable" }).blockers, []);
  const guarded = setup({ guards: ["observable-no-headless", "identity-proof-before-mutation", "reanchor-after-repeats"] });
  const blocked = guarded.learning.checkAction({ cluster: "browser", actionSummary: "run headless check", requestedSurface: "observable", targetName: "Ty's draft", repeatedAttempts: 3 });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.blockers.map((item) => item.guard).sort(), ["identity-proof-before-mutation", "observable-no-headless", "reanchor-after-repeats"]);
  assert.equal(guarded.learning.checkAction({ cluster: "browser", actionSummary: "open window", requestedSurface: "observable", targetName: "x", semanticIdentityProof: "matched id", repeatedAttempts: 3, progressMarker: "step 2 passed" }).allowed, true);
  incident(guarded.learning, 1, ["checkpoint:a"]);
  incident(guarded.learning, 2, ["checkpoint:b"]);
  const candidate = incident(guarded.learning, 3, ["checkpoint:c"]);
  assert.deepEqual(guarded.learning.checkAction({ cluster: "browser", actionSummary: "x" }).accepted_invariants, [], "a candidate is not policy");
  guarded.learning.promoteIncident("operation:p", { incidentId: candidate.id, approvalRef: approval(guarded.root, candidate), surface: local });
  assert.equal(guarded.learning.checkAction({ cluster: "browser", actionSummary: "x" }).accepted_invariants.length, 1);
  assert.equal(guarded.learning.checkAction({ cluster: "other", actionSummary: "x" }).accepted_invariants.length, 0);
  assert.throws(() => new LearningLayer(guarded.store, { guards: ["made-up" as never] }), /Unknown guard/);
});

test("context: rules in every mode, incident summaries in debug, incidents and chronicle in audit", () => {
  const { root, store, work, learning } = setup();
  incident(learning, 1, ["checkpoint:a"], { workId: work.id });
  incident(learning, 2, ["checkpoint:b"]);
  const candidate = incident(learning, 3, ["checkpoint:c"]);
  learning.promoteIncident("operation:p", { incidentId: candidate.id, approvalRef: approval(root, candidate), surface: local });
  learning.recordMilestone("operation:m1", { workId: work.id, stage: "decision", summary: "Chose the observable rail", provenance: ["checkpoint:a"], surface: local });
  assert.throws(() => learning.recordMilestone("operation:m2", { workId: work.id, stage: "chat" as never, summary: "x", surface: local }), /stage/);
  const clusters = clusterJournal(root);
  const normal = workContext(store, clusters, { workId: work.id, mode: "normal" }, learning) as any;
  assert.equal(normal.prevention_rules.length, 1);
  assert.equal(normal.incident_summaries, undefined);
  const debug = workContext(store, clusters, { workId: work.id, mode: "debug" }, learning) as any;
  assert.equal(debug.incident_summaries.length, 3);
  const audit = workContext(store, clusters, { workId: work.id, mode: "audit", budgetChars: 20_000 }, learning) as any;
  assert.equal(audit.chronicle.length, 1);
  assert.equal(audit.incidents.length, 3);
  assert.ok(JSON.stringify(audit).length <= 20_000);
});

test("friction climbs by occurrence", () => {
  const { learning } = setup();
  const record = (n: number) => learning.recordFriction(`operation:f${n}`, { cluster: "browser", component: "bridge", kind: "timeout", summary: "slow", surface: local }).event.tier;
  assert.deepEqual([record(1), record(2), record(3)], ["raw", "repeated", "learning_candidate"]);
  assert.equal(learning.friction.events()[0].provenance, undefined, "no provenance field unless given");
  const sourced = learning.recordFriction("operation:f4", { cluster: "browser", component: "bridge", kind: "timeout", summary: "slow", provenance: ["tool:bridge-log"], surface: local });
  assert.deepEqual(sourced.event.provenance, ["tool:bridge-log"]);
  assert.equal(sourced.event.occurrence, 4, "provenance never changes the count");
});

test("owner CLI issues receipts; agents close work and promote incidents over MCP with them", () => {
  const root = tmp();
  const resolveReceipt = receiptResolver(root);
  const store = new TrajectaStore(root, undefined, undefined, { resolveReceipt });
  const server = new WorkServer(store, local, { profile: { ...defaultProfile(), guards: ["reanchor-after-repeats"] }, resolveReceipt });
  const call = (name: string, args: Record<string, unknown>) => (server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
  const cli = (...args: string[]) => {
    const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env: { ...process.env, TRAJECTA_HOME: root }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const opened = call("work_open", { topic: "Ship", goal: "Ship the thing" }).structuredContent.work;
  let candidateId = "";
  for (const [n, evidence] of [[1, "checkpoint:a"], [2, "checkpoint:b"], [3, "checkpoint:c"]] as const) {
    const args = { work_id: opened.id, cluster: "browser", kind: "wrong-rail", summary: `n${n}`, violated_invariant: "observable requested", evidence_refs: [evidence], correction: "fixed", prevention_rule: "Never go headless", operation_id: `operation:i${n}` };
    const recorded = call("work_record_incident", args);
    assert.equal(recorded.isError, false, recorded.content[0].text);
    candidateId = recorded.structuredContent.incident_id;
    assert.equal(call("work_record_incident", args).structuredContent.replayed, true, "same operation replays");
  }
  assert.equal(call("work_record_incident", { work_id: opened.id, cluster: "browser", kind: "wrong-rail", summary: "changed", violated_invariant: "observable requested", evidence_refs: ["checkpoint:c"], correction: "fixed", prevention_rule: "Never go headless", operation_id: "operation:i3" }).isError, true, "altered replay is refused");
  const approved = cli("approve-promotion", candidateId);
  const promoted = call("work_promote_incident", { incident_id: candidateId, approval_ref: approved.approval_ref });
  assert.equal(promoted.isError, false, promoted.content[0].text);
  assert.equal(call("work_check_action", { cluster: "browser", action_summary: "retry", repeated_attempts: 4 }).structuredContent.allowed, false);
  assert.equal(call("work_check_action", { cluster: "browser", action_summary: "retry" }).structuredContent.accepted_invariants[0].rule, "Never go headless");
  const milestone = call("work_record_milestone", { work_id: opened.id, stage: "outcome", summary: "Shipped", provenance: ["test:green"] });
  assert.equal(milestone.isError, false, milestone.content[0].text);
  const current = call("work_get", { work_id: opened.id }).structuredContent.work;
  const closeReceipt = cli("approve-close", opened.id, "complete", "--summary", "Shipped", "--provenance", "test:green", "--evidence-class", "test");
  const wrong = call("work_close", { work_id: opened.id, expected_revision: current.revision, status: "complete", summary: "Shipped!", verification_ref: closeReceipt.verification_ref, provenance: ["test:green"] });
  assert.equal(wrong.isError, true, "a different summary does not match the approved intent");
  const closed = call("work_close", { work_id: opened.id, expected_revision: current.revision, status: "complete", summary: "Shipped", verification_ref: closeReceipt.verification_ref, provenance: ["test:green"] });
  assert.equal(closed.isError, false, closed.content[0].text);
  assert.equal(closed.structuredContent.work.status, "complete");
  const tools = (server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(!tools.some((name: string) => /approve|issue|receipt/.test(name)), "no MCP tool can issue a receipt");
});

test("import brings incidents, friction and chronicle; source invariants wait for re-approval", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const report = importLifecycle(store, SOURCE, "awm");
  assert.equal(report.learning.incidents, 3);
  assert.equal(report.learning.friction, 1);
  assert.deepEqual(new LearningLayer(store).friction.events()[0].provenance, ["source:awm:friction:f1"], "imported friction keeps its source id");
  assert.equal(report.learning.milestones, 1, "chronicle of the archived task is skipped");
  assert.ok(report.skipped.some((item) => item.eventId === "incident:bad"));
  assert.ok(report.skipped.some((item) => item.eventId === "chronicle:m2"));
  assert.equal(report.learning.invariantsPendingReapproval.length, 1);
  const pending = report.learning.invariantsPendingReapproval[0];
  assert.ok(pending.importedIncidentId?.startsWith("event:"));
  const learning = new LearningLayer(store);
  assert.equal(learning.rulesFor("memory-system").length, 0, "nothing is active without a new owner approval");
  const imported = learning.incidents.read().byId[pending.importedIncidentId!];
  assert.equal(imported.tier, "learning_candidate", "tiers recomputed from the same evidence");
  const again = importLifecycle(store, SOURCE, "awm");
  assert.equal(again.learning.incidents, 3);
  assert.equal(learning.incidents.events().length, 3, "re-import adds nothing");
});

test("re-import over a store imported before friction kept provenance replays, not skips", () => {
  const fresh = new TrajectaStore(tmp());
  importLifecycle(fresh, SOURCE, "awm");
  const recorded = new LearningLayer(fresh).friction.events()[0];
  const ledger = fs.readFileSync(path.join(fresh.root, "domain-operations.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const operationId = ledger.find((record) => record.domain === "friction").operationId;
  // What the previous release wrote: same operation, no provenance.
  const legacy = new TrajectaStore(tmp());
  new LearningLayer(legacy).recordFriction(operationId, { cluster: recorded.cluster, component: recorded.component, kind: recorded.kind, summary: recorded.summary, surface: recorded.surface });
  const report = importLifecycle(legacy, SOURCE, "awm");
  assert.equal(report.learning.friction, 1);
  assert.deepEqual(report.learning.frictionWithoutProvenance, ["friction:f1"]);
  assert.ok(!report.skipped.some((item) => item.eventId === "friction:f1"), "not reported as skipped");
  assert.equal(new LearningLayer(legacy).friction.events().length, 1, "no duplicate friction");
  assert.deepEqual(importLifecycle(fresh, SOURCE, "awm").learning.frictionWithoutProvenance, [], "a store imported with provenance replays cleanly");
});

test("import keeps identical evidence identical, so repeats never climb the tier", () => {
  const source = tmp();
  fs.cpSync(SOURCE, source, { recursive: true });
  const same = (id: string) => JSON.stringify({ id, cluster: "memory-system", kind: "wrong-rail", summary: id, violated_invariant: "observable requested", evidence_refs: ["checkpoint:same"], correction: "c", prevention_rule: "p" });
  fs.writeFileSync(path.join(source, "state", "incidents.jsonl"), `${same("incident:r1")}\n${same("incident:r2")}\n${same("incident:r3")}\n`);
  const store = new TrajectaStore(tmp());
  importLifecycle(store, source, "awm");
  const events = new LearningLayer(store).incidents.events();
  assert.deepEqual(events.map((event) => event.tier), ["raw", "raw", "raw"]);
  assert.deepEqual(events.map((event) => event.evidenceRefs), [["checkpoint:same"], ["checkpoint:same"], ["checkpoint:same"]]);
  assert.deepEqual(events.map((event) => event.provenance[0]), ["source:awm:incident:r1", "source:awm:incident:r2", "source:awm:incident:r3"]);
});

test("CLI keeps cues verbatim and refuses approvals work_close could never accept", () => {
  const root = tmp();
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env: { ...process.env, TRAJECTA_HOME: root }, encoding: "utf8" });
  const store = new TrajectaStore(root);
  let work = store.open({ operationId: "operation:o", topic: "fix dry run handling", goal: "Fix --dry-run handling", surface: local }).work;
  const routed = run("route", "fix", "--dry-run", "handling");
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(JSON.parse(routed.stdout)[0].workId, work.id);
  assert.equal(run("route", "--dry-run").status, 0);
  const noProvenance = run("approve-close", work.id, "complete", "--summary", "Done");
  assert.equal(noProvenance.status, 1);
  assert.match(noProvenance.stderr, /provenance/);
  work = store.capture({ operationId: "operation:loops", workId: work.id, expectedRevision: work.revision, surface: local, kind: "next_action", summary: "loops", openLoops: ["left"], nextAction: "x" }).work;
  const withLoops = run("approve-close", work.id, "complete", "--summary", "Done", "--provenance", "test:ok");
  assert.equal(withLoops.status, 1);
  assert.match(withLoops.stderr, /open loop/);
  assert.equal(run("approve-close", work.id, "abandoned", "--summary", "Dropped").status, 0, "abandoned may keep loops");
  assert.equal(Object.keys(receiptJournal(root).read().byId).length, 1, "refused approvals issued nothing");
});
