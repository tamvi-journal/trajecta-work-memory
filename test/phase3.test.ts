import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeIntentDigest, TrajectaStore, type StoreFaultPoint } from "../src/store.ts";
import type { WorkCloseReceipt } from "../src/types.ts";
import { ClaimConflict, claimFence, ClaimLayer } from "../src/claims.ts";
import { CaseLayer } from "../src/cases.ts";
import { SkillLayer } from "../src/skills.ts";
import { LearningLayer } from "../src/learning.ts";
import { clusterJournal } from "../src/clusters.ts";
import { workContext } from "../src/context.ts";
import { importLifecycle } from "../src/import-lifecycle.ts";
import { WorkServer } from "../src/mcp.ts";
import { defaultProfile } from "../src/boot.ts";
import { invariantDigest, issueReceipt, newReceiptId, receiptResolver, SkillApprovalRejected, type OwnerApprovalReceipt } from "../src/receipts.ts";
import { TrajectaRelay } from "../src/relay.ts";

const cloud = { kind: "cloud" as const, name: "Aux", session: "cloud:one" };
const local = { kind: "local" as const, name: "Aux", session: "local:two" };
const other = { kind: "local" as const, name: "Lam", session: "local:three" };
const SOURCE = fileURLToPath(new URL("./fixtures/lifecycle-source", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-phase3-"));
}

function fenced(options: { clock?: () => Date; resolveReceipt?: (ref: string) => unknown } = {}) {
  const root = tmp();
  const store = new TrajectaStore(root, options.clock, undefined, { admit: claimFence(root, { clock: options.clock }), resolveReceipt: options.resolveReceipt });
  const work = store.open({ operationId: "operation:open", topic: "Claims", goal: "Only one surface works at a time", surface: cloud }).work;
  const claims = new ClaimLayer(store, { clock: options.clock });
  return { root, store, work, claims };
}

function cli(root: string, ...args: string[]) {
  const out = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env: { ...process.env, TRAJECTA_HOME: root }, encoding: "utf8" });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, json: out.status === 0 ? JSON.parse(out.stdout) : null };
}

// --- claims -----------------------------------------------------------------------

test("claim fence: only the holder, with the exact epoch, can mutate a claimed work item", () => {
  const { store, work, claims } = fenced();
  const capture = (surface: typeof cloud, n: number, claimEpoch?: number) => store.capture({
    operationId: `operation:c${n}`, workId: work.id, expectedRevision: store.getWork(work.id).revision, surface, kind: "progress", summary: `step ${n}`,
    ...(claimEpoch === undefined ? {} : { claimEpoch }),
  });
  capture(cloud, 1); // no live claim: unchanged behaviour
  const claimed = claims.claim("operation:claim-1", { workId: work.id, surface: cloud }).event;
  assert.equal(claimed.epoch, 1);
  assert.throws(() => claims.claim("operation:claim-2", { workId: work.id, surface: local }), ClaimConflict);
  assert.throws(() => capture(local, 2, 1), ClaimConflict, "another session is refused even with the epoch");
  assert.throws(() => capture(cloud, 3), /pass claim_epoch/, "the holder must pass its epoch");
  assert.throws(() => capture(cloud, 4, 7), /Stale claim epoch/);
  assert.equal(capture(cloud, 5, 1).work.revision, 3);
  assert.throws(() => store.resume({ operationId: "operation:r1", workId: work.id, expectedRevision: 3, surface: local }), ClaimConflict);
  assert.throws(() => claims.release("operation:rel-x", { workId: work.id, surface: local, claimEpoch: 1 }), /Only the holder/);
  assert.throws(() => claims.release("operation:rel-y", { workId: work.id, surface: cloud, claimEpoch: 2 }), /Stale claim epoch/);
  claims.release("operation:rel-1", { workId: work.id, surface: cloud, claimEpoch: 1 });
  assert.throws(() => capture(cloud, 6, 1), /no live claim/, "a released epoch is refused");
  capture(local, 7);
  assert.equal(claims.claim("operation:claim-3", { workId: work.id, surface: local }).event.epoch, 2, "epoch keeps rising");
  const renewed = claims.claim("operation:claim-4", { workId: work.id, surface: local, leaseMinutes: 30 }).event;
  assert.equal(renewed.type, "renewed");
  assert.equal(renewed.epoch, 2, "renewal keeps the epoch");
  assert.equal(claims.claim("operation:claim-3", { workId: work.id, surface: local }).replayed, true, "same operation replays");
});

test("claim leases expire on their own and the epoch never resets", () => {
  let now = Date.parse("2026-09-29T00:00:00.000Z");
  const { store, work, claims } = fenced({ clock: () => new Date(now) });
  claims.claim("operation:claim-1", { workId: work.id, surface: cloud, leaseMinutes: 10 });
  assert.throws(() => store.capture({ operationId: "operation:c1", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "early" }), ClaimConflict);
  now += 11 * 60_000;
  assert.equal(claims.current(work.id), null);
  store.capture({ operationId: "operation:c2", workId: work.id, expectedRevision: 1, surface: local, kind: "progress", summary: "after expiry" });
  assert.throws(() => store.capture({ operationId: "operation:c3", workId: work.id, expectedRevision: 2, surface: cloud, kind: "progress", summary: "stale", claimEpoch: 1 }), /no live claim/);
  assert.equal(claims.claim("operation:claim-2", { workId: work.id, surface: local }).event.epoch, 2);
  assert.throws(() => claims.claim("operation:claim-3", { workId: work.id, surface: cloud, leaseMinutes: 721 }), /lease_minutes/);
});

test("claim fence on close: refused before the verifier runs, and re-checked after it", () => {
  let calls = 0;
  const holder: { claims?: ClaimLayer } = {};
  const setup = fenced({ resolveReceipt: () => { calls += 1; holder.claims?.claim("operation:late-claim", { workId: setup.work.id, surface: other }); return null; } });
  const { store, work, claims } = setup;
  const close = (surface: typeof cloud, op: string) => store.close({
    operationId: op, workId: work.id, expectedRevision: 1, surface, status: "abandoned", summary: "stop", verificationRef: "receipt:none", provenance: [],
  });
  claims.claim("operation:claim-1", { workId: work.id, surface: cloud });
  assert.throws(() => close(local, "operation:close-1"), ClaimConflict);
  assert.equal(calls, 0, "a refused caller never reaches the verifier");
  claims.release("operation:rel-1", { workId: work.id, surface: cloud, claimEpoch: 1 });
  holder.claims = claims; // the verifier now races a claim in
  assert.throws(() => close(local, "operation:close-2"), ClaimConflict, "stage 3 sees the claim taken while the verifier ran");
  assert.equal(calls, 1);
  assert.equal(store.getWork(work.id).status, "active");
});

test("handoff and resume pass the claim epoch through; a claim does not move by itself", () => {
  const { store, work, claims } = fenced();
  const epoch = claims.claim("operation:claim-1", { workId: work.id, surface: cloud }).event.epoch;
  const sender = new TrajectaRelay(store, cloud);
  const sent = sender.handoff({ operationId: "operation:h1", workId: work.id, expectedRevision: 1, summary: "over to local", provenance: [], openLoops: [], nextAction: "continue", target: "local", cue: "claims", claimEpoch: epoch });
  assert.throws(() => new TrajectaRelay(store, local).accept(sent.packet, "operation:a1"), ClaimConflict, "the sender still holds the claim");
  claims.release("operation:rel-1", { workId: work.id, surface: cloud, claimEpoch: epoch });
  const localEpoch = claims.claim("operation:claim-2", { workId: work.id, surface: local }).event.epoch;
  assert.equal(new TrajectaRelay(store, local).accept(sent.packet, "operation:a2", undefined, localEpoch).work.lastSurface?.session, local.session);
});

test("MCP: claims need a fenced store; the fence is enforced across servers", () => {
  const plain = new WorkServer(new TrajectaStore(tmp()), cloud, { profile: defaultProfile() });
  const call0 = (name: string, args: Record<string, unknown>) => (plain.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
  const opened0 = call0("work_open", { topic: "t", goal: "g" }).structuredContent.work;
  assert.match(call0("work_claim", { work_id: opened0.id }).content[0].text, /does not enforce claims/);

  const root = tmp();
  const server = (surface: typeof cloud) => new WorkServer(new TrajectaStore(root, undefined, undefined, { admit: claimFence(root) }), surface, { profile: defaultProfile() });
  const a = server(cloud);
  const b = server(local);
  const call = (s: WorkServer, name: string, args: Record<string, unknown>) => (s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
  const opened = call(a, "work_open", { topic: "Shared", goal: "One writer" }).structuredContent.work;
  const claim = call(a, "work_claim", { work_id: opened.id }).structuredContent;
  assert.equal(claim.claim_epoch, 1);
  const refused = call(b, "work_capture", { work_id: opened.id, expected_revision: 1, kind: "progress", summary: "b" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /ClaimConflict/);
  assert.equal(call(a, "work_capture", { work_id: opened.id, expected_revision: 1, kind: "progress", summary: "a", claim_epoch: 1 }).isError, false);
  assert.equal(call(a, "work_release", { work_id: opened.id, claim_epoch: 1 }).isError, false);
  assert.equal(call(b, "work_capture", { work_id: opened.id, expected_revision: 2, kind: "progress", summary: "b" }).isError, false);
});

// --- cases and hypotheses -----------------------------------------------------------

function caseSetup() {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = store.open({ operationId: "operation:open", topic: "Debug", goal: "Find why the bridge drops", surface: local }).work;
  const cases = new CaseLayer(store);
  cases.recordCaseEvent("operation:case-open", { caseId: "case:bridge-drop", eventType: "open", title: "Bridge drops", workIds: [work.id], evidenceRefs: ["checkpoint:a"], surface: local });
  return { root, store, work, cases };
}

test("hypothesis verdicts are agent-attested with a typed ref in the matching evidence, and final", () => {
  const { cases } = caseSetup();
  const hyp = (op: string, extra: Record<string, unknown>) => cases.recordHypothesis(op, {
    hypothesisId: "hypothesis:timeout", caseId: "case:bridge-drop", statement: "The bridge times out after 60s", surface: local, status: "hypothesis", ...extra,
  } as never);
  hyp("operation:h1", { supportingRefs: ["checkpoint:a"] });
  assert.throws(() => hyp("operation:h2", { status: "hypothesis", verificationRef: "test:x", supportingRefs: ["test:x"] }), /carries no verification_ref/);
  assert.throws(() => hyp("operation:h3", { status: "supported", verificationRef: "checkpoint:a", supportingRefs: ["checkpoint:a"] }), /test:, commit:/);
  assert.throws(() => hyp("operation:h4", { status: "supported", verificationRef: "test:timeout-60", supportingRefs: ["checkpoint:a"] }), /must appear in supporting_refs/);
  assert.throws(() => hyp("operation:h5", { status: "refuted", verificationRef: "test:timeout-60", supportingRefs: ["test:timeout-60"] }), /disconfirming_refs/);
  assert.throws(() => hyp("operation:h6", { statement: "Something else", status: "hypothesis" }), /keeps its case, statement/);
  const verdict = hyp("operation:h7", { status: "supported", verificationRef: "test:timeout-60", supportingRefs: ["checkpoint:a", "test:timeout-60"] }).event as any;
  assert.equal(verdict.attestation, "agent");
  assert.deepEqual(verdict.author, local);
  assert.throws(() => hyp("operation:h8", { status: "refuted", verificationRef: "test:y", disconfirmingRefs: ["test:y"] }), /a verdict is final/);
});

test("case status follows the transition table; resolved names its supported basis", () => {
  const { store, cases } = caseSetup();
  const status = (op: string, next: string, extra: Record<string, unknown> = {}) => cases.recordCaseEvent(op, { caseId: "case:bridge-drop", eventType: "status", status: next as never, evidenceRefs: ["checkpoint:b"], surface: local, ...extra });
  assert.throws(() => status("operation:s1", "reopened"), /cannot go from open to reopened/);
  assert.throws(() => status("operation:s2", "resolved"), /needs resolution_hypothesis_ids/);
  cases.recordHypothesis("operation:h1", { hypothesisId: "hypothesis:open-one", caseId: "case:bridge-drop", status: "hypothesis", statement: "Maybe DNS", surface: local });
  assert.throws(() => status("operation:s3", "resolved", { resolutionHypothesisIds: ["hypothesis:open-one"] }), /not supported/);
  assert.throws(() => status("operation:s4", "resolved", { resolutionHypothesisIds: ["hypothesis:missing"] }), /is not a hypothesis of/);
  cases.recordHypothesis("operation:h2", { hypothesisId: "hypothesis:timeout", caseId: "case:bridge-drop", status: "supported", statement: "Timeout", supportingRefs: ["test:t"], verificationRef: "test:t", surface: local });
  const resolved = status("operation:s5", "resolved", { resolutionHypothesisIds: ["hypothesis:timeout"] }).event as any;
  assert.equal(resolved.from, "open");
  assert.deepEqual(cases.getCase("case:bridge-drop").resolution_hypothesis_ids, ["hypothesis:timeout"]);
  assert.throws(() => status("operation:s6", "deprioritized"), /cannot go from resolved/);
  assert.throws(() => cases.recordCaseEvent("operation:m1", { caseId: "case:bridge-drop", eventType: "member_added", incidentId: "event:nope", evidenceRefs: ["checkpoint:c"], surface: local }), /Incident not found/);
  assert.throws(() => cases.recordCaseEvent("operation:o2", { caseId: "case:bridge-drop", eventType: "open", title: "again", workIds: [store.list()[0].id], evidenceRefs: ["checkpoint:c"], surface: local }), /already exists/);
  assert.throws(() => cases.recordCaseEvent("operation:o3", { caseId: "case:other", eventType: "open", title: "x", workIds: ["work:missing"], evidenceRefs: ["checkpoint:c"], surface: local }));
});

test("imported support is history: a reopened imported case resolves only on a supported hypothesis attested here", () => {
  const store = new TrajectaStore(tmp());
  const report = importLifecycle(store, SOURCE, "awm");
  assert.equal(report.investigation.cases, 1);
  assert.ok(report.skipped.some((item) => item.eventId === "case-event:e4"), "a case on archived work only is skipped");
  const cases = new CaseLayer(store);
  const imported = cases.getCase("case:headless-drift", "debug");
  assert.equal(imported.status, "resolved");
  assert.equal(imported.attestation, "imported");
  assert.equal(imported.incident_ids.length, 1);
  assert.equal(imported.hypotheses[0].attestation, "imported");
  const status = (op: string, next: string, ids?: string[]) => cases.recordCaseEvent(op, { caseId: "case:headless-drift", eventType: "status", status: next as never, resolutionHypothesisIds: ids, evidenceRefs: ["checkpoint:x"], surface: local });
  status("operation:reopen", "reopened");
  assert.throws(() => status("operation:resolve-1", "resolved", ["hypothesis:default-rail"]), /attested in this store/);
  cases.recordHypothesis("operation:h-local", { hypothesisId: "hypothesis:local-check", caseId: "case:headless-drift", status: "supported", statement: "Rail default confirmed locally", supportingRefs: ["test:rail"], verificationRef: "test:rail", surface: local });
  status("operation:resolve-2", "resolved", ["hypothesis:default-rail", "hypothesis:local-check"]);
  assert.equal(importLifecycle(store, SOURCE, "awm").investigation.caseEvents, 2, "re-import replays");
});

test("work_context: linked cases in every mode, hypotheses from debug, case events in audit; active skills only", () => {
  const { store, work, cases } = caseSetup();
  cases.recordHypothesis("operation:h1", { hypothesisId: "hypothesis:timeout", caseId: "case:bridge-drop", status: "hypothesis", statement: "Timeout", surface: local });
  clusterJournal(store.root).append("operation:assign", { work: work.id }, () => ({ type: "assign" as const, workId: work.id, cluster: "browser", reason: "t", surface: local }));
  const skills = new SkillLayer(store.root);
  skills.proposeVersion("operation:v1", { skillId: "observable", versionId: "v1", cluster: "browser", content: "Candidate", motivatingRefs: ["checkpoint:a"], surface: local });
  const ctx = (mode: "normal" | "debug" | "audit") => workContext(store, clusterJournal(store.root), { workId: work.id, mode, budgetChars: 20_000 }, null, { cases, skills }) as any;
  const normal = ctx("normal");
  assert.equal(normal.linked_cases[0].case_id, "case:bridge-drop");
  assert.equal(normal.linked_cases[0].hypotheses, undefined);
  assert.deepEqual(normal.active_skills, [], "a candidate version never reaches context");
  assert.equal(ctx("debug").linked_cases[0].hypotheses[0].id, "hypothesis:timeout");
  const audit = ctx("audit");
  assert.equal(audit.case_events.length, 1);
  assert.deepEqual(audit.linked_cases[0].hypotheses[0].author, local);
});

// --- skills ---------------------------------------------------------------------------

function skillSetup() {
  const root = tmp();
  const skills = new SkillLayer(root, { resolveReceipt: receiptResolver(root) });
  const propose = (versionId: string, parentVersionId: string | null, content = `content ${versionId}`) =>
    skills.proposeVersion(`operation:propose-${versionId}`, { skillId: "observable", versionId, parentVersionId, cluster: "browser", content, motivatingRefs: ["checkpoint:a"], surface: cloud });
  const validate = (versionId: string, surface = local, scores = [0.4, 0.8], n = "") => skills.recordValidation(`operation:validate-${versionId}-${surface.session.replace(":", "-")}-${scores.join("-")}${n}`, {
    skillId: "observable", versionId, outcome: "accepted", baselineScore: scores[0], candidateScore: scores[1], evidenceRefs: ["test:replay"], reason: "better", surface,
  }).event as { decisionId: string; eligible: boolean };
  return { root, skills, propose, validate };
}

test("versions are immutable children; accepted validation needs a better score and another session", () => {
  const { skills, propose, validate } = skillSetup();
  propose("v1", null);
  assert.throws(() => propose("v1", null, "changed"), /already exists|reused with different input/);
  assert.throws(() => skills.proposeVersion("operation:p-orphan", { skillId: "observable", versionId: "v9", cluster: "browser", content: "x", motivatingRefs: ["checkpoint:a"], surface: cloud }), /Only a skill's first version/);
  assert.throws(() => propose("v2", "missing"), /Parent version missing not found/);
  assert.throws(() => validate("v1", cloud), /different session/, "D2: the proposer's session cannot accept its own version");
  assert.throws(() => validate("v1", local, [0.8, 0.8]), /strictly above/);
  const rejected = skills.recordValidation("operation:reject", { skillId: "observable", versionId: "v1", outcome: "rejected", evidenceRefs: ["test:replay"], reason: "worse", surface: cloud });
  assert.equal((rejected.event as any).eligible, false, "rejections need no independence and back nothing");
  assert.equal(validate("v1").eligible, true);
});

test("activation and rollback need owner receipts from the CLI, CAS on the pointer, and matching purposes", () => {
  const { root, skills, propose, validate } = skillSetup();
  propose("v1", null);
  const d1 = validate("v1").decisionId;
  const refused = cli(root, "approve-skill", "observable", "v1", "decision:nope");
  assert.notEqual(refused.status, 0, "no receipt for a decision that is not an accepted validation of this version");
  const a1 = cli(root, "approve-skill", "observable", "v1", d1);
  assert.equal(a1.status, 0, a1.stderr);
  assert.throws(() => skills.activate("operation:act-wrong", { skillId: "observable", versionId: "v1", decisionId: d1, approvalRef: "receipt:missing", surface: cloud }), SkillApprovalRejected);
  skills.activate("operation:act-1", { skillId: "observable", versionId: "v1", decisionId: d1, approvalRef: a1.json.approval_ref, surface: cloud });
  assert.equal(skills.getSkill("observable").active?.version_id, "v1");
  assert.equal(skills.activate("operation:act-1", { skillId: "observable", versionId: "v1", decisionId: d1, approvalRef: a1.json.approval_ref, surface: cloud }).replayed, true);

  propose("v2", "v1");
  propose("v3", "v1");
  const d2 = validate("v2").decisionId;
  const d3 = validate("v3").decisionId;
  const a2 = cli(root, "approve-skill", "observable", "v2", d2).json;
  const a3 = cli(root, "approve-skill", "observable", "v3", d3).json;
  skills.activate("operation:act-2", { skillId: "observable", versionId: "v2", decisionId: d2, approvalRef: a2.approval_ref, surface: cloud });
  assert.throws(() => skills.activate("operation:act-3", { skillId: "observable", versionId: "v3", decisionId: d3, approvalRef: a3.approval_ref, surface: cloud }), /direct child of the active version/, "a sibling cannot jump the pointer");
  assert.throws(() => skills.activate("operation:act-4", { skillId: "observable", versionId: "v2", decisionId: d2, approvalRef: a2.approval_ref, surface: cloud }), /direct child/);

  assert.notEqual(cli(root, "approve-rollback", "observable", "v3", "--reason", "x").status, 0, "never-active target is refused");
  const r1 = cli(root, "approve-rollback", "observable", "v1", "--reason", "v2 regressed");
  assert.equal(r1.status, 0, r1.stderr);
  assert.throws(() => skills.rollback("operation:rb-0", { skillId: "observable", toVersionId: "v1", reason: "different reason", approvalRef: r1.json.approval_ref, surface: cloud }), /different reason/);
  assert.throws(() => skills.rollback("operation:rb-1", { skillId: "observable", toVersionId: "v1", reason: "v2 regressed", approvalRef: a2.approval_ref, surface: cloud }), /cannot roll a skill back/, "an activation receipt cannot roll back");
  skills.rollback("operation:rb-2", { skillId: "observable", toVersionId: "v1", reason: "v2 regressed", approvalRef: r1.json.approval_ref, surface: cloud });
  const audit = skills.getSkill("observable", "audit") as any;
  assert.equal(audit.active.version_id, "v1");
  assert.deepEqual(audit.ever_active, ["v1", "v2"]);
  assert.equal(audit.pointer_events.length, 3);

  const promotion: OwnerApprovalReceipt = {
    schema: "trajecta.owner-approval-receipt/v1", id: newReceiptId(), purpose: "incident_promotion", incidentId: "event:x",
    invariantDigest: invariantDigest({ incidentId: "event:x", cluster: "browser", preventionRule: "r", violatedInvariant: "v" }),
    authority: "owner", outcome: "approved", provenance: [], issuedAt: new Date(Date.now() - 1_000).toISOString(),
  };
  issueReceipt(root, promotion);
  const d3b = validate("v3", local, [0.1, 0.9], "-again").decisionId;
  assert.throws(() => skills.activate("operation:act-5", { skillId: "observable", versionId: "v3", decisionId: d3b, approvalRef: promotion.id, surface: cloud }), /cannot activate a skill/, "an incident promotion receipt cannot activate");
});

test("imported skill history is never active and imported validations never back an activation", () => {
  const store = new TrajectaStore(tmp());
  const report = importLifecycle(store, SOURCE, "awm");
  assert.equal(report.investigation.versions, 2);
  assert.equal(report.investigation.validations, 1);
  assert.deepEqual(report.investigation.skillsPendingReactivation.map((item) => item.versionId), ["skill-version:v1"]);
  const skills = new SkillLayer(store.root);
  assert.equal(skills.getSkill("skill:observable-browser").active, null);
  const [decisionId, decision] = Object.entries(skills.journal.read().validations)[0];
  assert.equal(decision.eligible, false);
  assert.throws(() => skills.activationTerms(skills.journal.read(), "skill:observable-browser", "skill-version:v1", decisionId), /cannot back an activation/);
  const fresh = skills.recordValidation("operation:revalidate", { skillId: "skill:observable-browser", versionId: "skill-version:v1", outcome: "accepted", baselineScore: 0.4, candidateScore: 0.9, evidenceRefs: ["test:replay"], reason: "re-checked here", surface: local });
  assert.ok(skills.activationTerms(skills.journal.read(), "skill:observable-browser", "skill-version:v1", (fresh.event as any).decisionId));
});

test("MCP: Phase 3 tools stamp the server surface, and none issues a receipt", () => {
  const root = tmp();
  const server = new WorkServer(new TrajectaStore(root, undefined, undefined, { admit: claimFence(root) }), cloud, { profile: defaultProfile() });
  const call = (name: string, args: Record<string, unknown>) => (server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
  const opened = call("work_open", { topic: "Debug", goal: "g" }).structuredContent.work;
  assert.equal(call("work_case_open", { case_id: "case:mcp", title: "MCP case", work_ids: [opened.id], evidence_refs: ["checkpoint:a"] }).isError, false);
  const spoof = call("work_hypothesis", { hypothesis_id: "hypothesis:h", case_id: "case:mcp", status: "hypothesis", statement: "s", author: "someone-else" });
  assert.equal(spoof.isError, false);
  assert.deepEqual(new CaseLayer(server.store).journal.read().hypotheses["hypothesis:h"].author, cloud, "author comes from the server surface, not arguments");
  const proposed = call("work_skill_propose", { skill_id: "observable", version_id: "v1", cluster: "browser", content: "c", motivating_refs: ["checkpoint:a"] });
  assert.equal(proposed.isError, false, proposed.content[0].text);
  const own = call("work_skill_validate", { skill_id: "observable", version_id: "v1", outcome: "accepted", baseline_score: 0.1, candidate_score: 0.9, evidence_refs: ["test:x"], reason: "r" });
  assert.equal(own.isError, true, "the proposing session cannot accept its own version");
  const tools = (server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any).result.tools.map((tool: { name: string }) => tool.name);
  assert.equal(tools.length, 30);
  assert.ok(!tools.some((name: string) => /approve|issue|receipt/.test(name)));
});

test("learning layer still reads incidents for case membership", () => {
  const { store, cases } = caseSetup();
  const learning = new LearningLayer(store);
  const incident = learning.recordIncident("operation:i1", { cluster: "browser", kind: "drop", summary: "dropped", violatedInvariant: "stay up", evidenceRefs: ["checkpoint:z"], correction: "retry", preventionRule: "keep alive", surface: local }).event;
  cases.recordCaseEvent("operation:m1", { caseId: "case:bridge-drop", eventType: "member_added", incidentId: incident.id, evidenceRefs: ["checkpoint:z"], surface: local });
  assert.throws(() => cases.recordCaseEvent("operation:m2", { caseId: "case:bridge-drop", eventType: "member_added", incidentId: incident.id, evidenceRefs: ["checkpoint:z"], surface: local }), /already in this case/);
  cases.recordCaseEvent("operation:m3", { caseId: "case:bridge-drop", eventType: "member_removed", incidentId: incident.id, evidenceRefs: ["checkpoint:z"], surface: local });
  assert.deepEqual(cases.getCase("case:bridge-drop").incident_ids, []);
});

// --- review fixes (Lam on #9) ---------------------------------------------------------

function crashingStore(root: string, at: StoreFaultPoint, resolveReceipt?: (ref: string) => unknown) {
  let armed = false;
  const store = new TrajectaStore(root, undefined, (point) => { if (armed && point === at) throw new Error(`crash at ${point}`); }, { admit: claimFence(root), resolveReceipt });
  return { store, arm: () => { armed = true; } };
}

for (const at of ["after-reserve", "after-delta"] as const) {
  test(`a claim is granted only on settled state: a close that crashed ${at} is recovered and the claim refused`, () => {
    const root = tmp();
    const resolveReceipt = receiptResolver(root);
    const { store, arm } = crashingStore(root, at, resolveReceipt);
    const work = store.open({ operationId: "operation:open", topic: "Crash", goal: "Close then crash", surface: cloud }).work;
    const receipt: WorkCloseReceipt = {
      schema: "trajecta.work-close-receipt/v1", id: newReceiptId(), purpose: "work_close", workId: work.id, expectedRevision: 1, status: "abandoned",
      intentDigest: closeIntentDigest({ workId: work.id, expectedRevision: 1, status: "abandoned", summary: "stop", provenance: [] }),
      authority: "owner", evidenceClass: "", outcome: "approved", issuedAt: new Date(Date.now() - 1_000).toISOString(),
    } as WorkCloseReceipt;
    issueReceipt(root, receipt);
    arm();
    assert.throws(() => store.close({ operationId: "operation:close", workId: work.id, expectedRevision: 1, surface: cloud, status: "abandoned", summary: "stop", verificationRef: receipt.id, provenance: [] }), /crash at/);
    const other = new TrajectaStore(root, undefined, undefined, { admit: claimFence(root) });
    const claims = new ClaimLayer(other);
    assert.throws(() => claims.claim("operation:claim-b", { workId: work.id, surface: local }), /Closed work cannot be claimed/);
    assert.equal(claims.current(work.id), null, "no live claim is left behind");
    assert.equal(other.getWork(work.id).status, "abandoned", "the pending close was settled first");
  });
}

test("a pending capture is settled before a claim is granted", () => {
  const root = tmp();
  const { store, arm } = crashingStore(root, "after-delta");
  const work = store.open({ operationId: "operation:open", topic: "Crash", goal: "Capture then crash", surface: cloud }).work;
  arm();
  assert.throws(() => store.capture({ operationId: "operation:cap", workId: work.id, expectedRevision: 1, surface: cloud, kind: "progress", summary: "half written" }), /crash at/);
  const other = new TrajectaStore(root, undefined, undefined, { admit: claimFence(root) });
  const claim = new ClaimLayer(other).claim("operation:claim-b", { workId: work.id, surface: local }).event;
  assert.equal(claim.epoch, 1);
  assert.equal(other.getWork(work.id).revision, 2, "the capture was committed before the claim");
  assert.throws(() => new ClaimLayer(other).journal.readHeld(), /root write lock/, "held-only reads refuse without the lock");
  assert.throws(() => other.getWorkSettledHeld(work.id), /root write lock/);
});

test("skill receipts bind the pointer epoch: old activation and rollback receipts never come back (no ABA)", () => {
  const { root, skills, propose, validate } = skillSetup();
  const activate = (op: string, versionId: string, decisionId: string, approvalRef: string) => skills.activate(op, { skillId: "observable", versionId, decisionId, approvalRef, surface: cloud });
  const rollback = (op: string, toVersionId: string, approvalRef: string) => skills.rollback(op, { skillId: "observable", toVersionId, reason: "regressed", approvalRef, surface: cloud });
  propose("v1", null);
  const d1 = validate("v1").decisionId;
  const a1 = cli(root, "approve-skill", "observable", "v1", d1).json;
  assert.equal(a1.expectedPointerEpoch, 0);
  activate("operation:act-v1", "v1", d1, a1.approval_ref);
  propose("v2", "v1");
  const d2 = validate("v2").decisionId;
  const a2 = cli(root, "approve-skill", "observable", "v2", d2).json;
  assert.equal(a2.expectedPointerEpoch, 1);
  activate("operation:act-v2", "v2", d2, a2.approval_ref);
  const r1 = cli(root, "approve-rollback", "observable", "v1", "--reason", "regressed").json;
  rollback("operation:rb-v1", "v1", r1.approval_ref);
  assert.equal(skills.getSkill("observable").pointer_epoch, 3);
  assert.throws(() => activate("operation:act-v2-again", "v2", d2, a2.approval_ref), /pointer epoch 1; the pointer is now at epoch 3/, "the old v1→v2 receipt is dead");
  const a2b = cli(root, "approve-skill", "observable", "v2", d2).json;
  activate("operation:act-v2-fresh", "v2", d2, a2b.approval_ref);
  assert.throws(() => rollback("operation:rb-v1-again", "v1", r1.approval_ref), /pointer epoch 2; the pointer is now at epoch 4/, "the old rollback receipt is dead too");
  assert.equal(skills.getSkill("observable").active?.version_id, "v2");
});
