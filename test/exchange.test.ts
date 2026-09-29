import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HandoffInTransit, TrajectaStore, type StoreFaultPoint } from "../src/store.ts";
import { ClaimConflict, claimFence, ClaimLayer } from "../src/claims.ts";
import { exchangeProfile, defaultProfile, PROFILE_FILE } from "../src/boot.ts";
import { assertActor, surfaceFrom, WorkServer } from "../src/mcp.ts";
import { TrajectaRelay } from "../src/relay.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const auxLocal = { kind: "local" as const, name: "Aux", session: "local:aux", actor: "aux" };
const auxCloud = { kind: "cloud" as const, name: "Aux", session: "cloud:aux", actor: "aux" };
const lamLocal = { kind: "local" as const, name: "Lam", session: "local:lam", actor: "lam" };
const profile = exchangeProfile([{ id: "aux", surfaces: ["cloud", "local"] }, { id: "lam", surfaces: ["local"] }], "ty");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-exchange-"));
}

function exchange(clock?: () => Date) {
  const root = tmp();
  const store = new TrajectaStore(root, clock, undefined, { admit: claimFence(root, { requireClaim: true, clock }) });
  const server = (surface: typeof auxLocal) => new WorkServer(store, surface, { profile });
  const call = (server: WorkServer, name: string, args: Record<string, unknown> = {}) => {
    const result = (server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
    return { ok: !result.isError, text: result.content[0].text as string, data: result.structuredContent };
  };
  return { root, store, server, call, claims: new ClaimLayer(store, { clock }) };
}

test("exchange protocol: claim to work, release to hand off, recipient claims before it resumes", () => {
  const { server, call } = exchange();
  const aux = server(auxLocal);
  const auxC = server(auxCloud);
  const lam = server(lamLocal);
  const opened = call(aux, "work_open", { topic: "Shared", goal: "Ship together" }).data.work;
  assert.match(call(aux, "work_capture", { work_id: opened.id, expected_revision: 1, kind: "progress", summary: "x" }).text, /Claim this work first/);
  const epoch = call(aux, "work_claim", { work_id: opened.id }).data.claim_epoch;
  assert.equal(call(aux, "work_capture", { work_id: opened.id, expected_revision: 1, kind: "progress", summary: "x", claim_epoch: epoch }).ok, true);
  const handoff = { work_id: opened.id, expected_revision: 2, summary: "over to Lam", cue: "shared", to_actor: "lam" };
  assert.match(call(aux, "work_handoff", { ...handoff, claim_epoch: epoch }).text, /needs no live claim.*release it first/);
  assert.match(call(aux, "work_handoff", { ...handoff, to_actor: "aux" }).text, /another actor/);
  assert.match(call(aux, "work_handoff", { ...handoff, to_actor: "ty" }).text, /to_actor must be one of/);
  assert.equal(call(aux, "work_release", { work_id: opened.id, claim_epoch: epoch }).ok, true);
  const sent = call(aux, "work_handoff", handoff);
  assert.equal(sent.ok, true, sent.text);
  assert.equal(sent.data.packet.intendedFor, "local");
  assert.equal(sent.data.packet.intendedActor, "lam");
  assert.equal(sent.data.work.pending_handoff.to_actor, "lam");
  assert.equal(sent.data.work.pending_handoff.for_me, false);

  assert.deepEqual(call(aux, "work_inbox").data.work, []);
  const inbox = call(lam, "work_inbox").data.work;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].pending_handoff.for_me, true);
  assert.match(call(auxC, "work_claim", { work_id: opened.id }).text, /only that recipient can claim it/, "nobody else can slip in");
  assert.match(call(lam, "work_resume", { work_id: opened.id, expected_revision: 3 }).text, /Claim this work first/, "claim before resume");
  const lamEpoch = call(lam, "work_claim", { work_id: opened.id }).data.claim_epoch;
  assert.equal(lamEpoch, 2, "epoch keeps rising across holders");
  const resumed = call(lam, "work_resume", { work_id: opened.id, expected_revision: 3, claim_epoch: lamEpoch });
  assert.equal(resumed.ok, true, resumed.text);
  assert.equal(resumed.data.work.pending_handoff, undefined, "resume clears the pending handoff in the same commit");
  assert.equal(call(lam, "work_capture", { work_id: opened.id, expected_revision: 4, kind: "decision", summary: "Lam decides", claim_epoch: lamEpoch }).ok, true);
});

test("core recipient rules hold without any fence: exact actor and surface, nothing else moves while in transit", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = store.open({ operationId: "operation:open", topic: "Raw", goal: "Core only", surface: auxLocal }).work;
  const sent = store.capture({ operationId: "operation:h", workId: work.id, expectedRevision: 1, surface: auxLocal, kind: "handoff", summary: "to lam", targetSurface: "local", targetActor: "lam" });
  const pending = sent.work.pendingHandoff!;
  assert.deepEqual({ ...pending, createdAt: undefined }, { fromActor: "aux", toActor: "lam", toSurfaceKind: "local", handoffDeltaId: sent.delta.id, revision: 2, createdAt: undefined });
  assert.equal(sent.delta.targetActor, "lam");
  const resume = (surface: typeof auxLocal, op: string) => store.resume({ operationId: op, workId: work.id, expectedRevision: 2, surface });
  assert.throws(() => resume(auxLocal, "operation:r1"), HandoffInTransit);
  assert.throws(() => resume({ ...lamLocal, kind: "cloud", session: "cloud:lam" }, "operation:r2"), /only lam on local/);
  assert.throws(() => store.capture({ operationId: "operation:c1", workId: work.id, expectedRevision: 2, surface: auxLocal, kind: "progress", summary: "x" }), HandoffInTransit);
  assert.throws(() => store.capture({ operationId: "operation:h2", workId: work.id, expectedRevision: 2, surface: auxLocal, kind: "handoff", summary: "again", targetSurface: "local", targetActor: "lam" }), HandoffInTransit, "no second handoff over a pending one");
  assert.throws(() => store.close({ operationId: "operation:close", workId: work.id, expectedRevision: 2, surface: auxLocal, status: "abandoned", summary: "x", verificationRef: "receipt:x", provenance: [] }));
  assert.throws(() => store.capture({ operationId: "operation:x1", workId: work.id, expectedRevision: 2, surface: lamLocal, kind: "handoff_cancel", summary: "not mine" }), /only the sender/);
  assert.throws(() => store.transfer(work.id, "cue", "cloud"), /only be made for local/);
  const cancelled = store.capture({ operationId: "operation:x2", workId: work.id, expectedRevision: 2, surface: auxLocal, kind: "handoff_cancel", summary: "changed my mind" });
  assert.equal(cancelled.work.pendingHandoff, null);
  assert.equal(cancelled.work.status, "active");
  assert.throws(() => store.capture({ operationId: "operation:x3", workId: work.id, expectedRevision: 3, surface: auxLocal, kind: "handoff_cancel", summary: "nothing" }), /No handoff is pending/);
  assert.throws(() => store.capture({ operationId: "operation:h3", workId: work.id, expectedRevision: 3, surface: auxLocal, kind: "handoff", summary: "x", targetSurface: "local", targetActor: "aux" }), /another actor/);
  assert.throws(() => store.capture({ operationId: "operation:h4", workId: work.id, expectedRevision: 3, surface: { kind: "local", name: "anon", session: "s" }, kind: "handoff", summary: "x", targetSurface: "local", targetActor: "lam" }), /sender actor/);
  const again = store.capture({ operationId: "operation:h5", workId: work.id, expectedRevision: 3, surface: auxLocal, kind: "handoff", summary: "again", targetSurface: "local", targetActor: "lam" });
  const resumed = store.resume({ operationId: "operation:r3", workId: work.id, expectedRevision: again.work.revision, surface: lamLocal });
  assert.equal(resumed.work.pendingHandoff, null);
});

for (const at of ["after-reserve", "after-delta"] as StoreFaultPoint[]) {
  test(`a handoff that crashed ${at} still binds its recipient once recovered (one commit)`, () => {
    const root = tmp();
    let armed = false;
    const store = new TrajectaStore(root, undefined, (point) => { if (armed && point === at) throw new Error(`crash at ${point}`); });
    const work = store.open({ operationId: "operation:open", topic: "Crash", goal: "Hand off then crash", surface: auxLocal }).work;
    armed = true;
    assert.throws(() => store.capture({ operationId: "operation:h", workId: work.id, expectedRevision: 1, surface: auxLocal, kind: "handoff", summary: "to lam", targetSurface: "local", targetActor: "lam" }), /crash at/);
    const after = new TrajectaStore(root);
    assert.throws(() => after.capture({ operationId: "operation:c", workId: work.id, expectedRevision: 2, surface: auxLocal, kind: "progress", summary: "sneak" }), HandoffInTransit, "recovery completes the handoff and its binding together");
    assert.equal(after.getWork(work.id).pendingHandoff?.toActor, "lam");
  });
}

test("a recipient's live claim blocks the sender's cancel until its lease expires", () => {
  let now = Date.parse("2026-09-29T02:00:00.000Z");
  const { server, call } = exchange(() => new Date(now));
  const aux = server(auxLocal);
  const lam = server(lamLocal);
  const opened = call(aux, "work_open", { topic: "Shared", goal: "g" }).data.work;
  assert.equal(call(aux, "work_handoff", { work_id: opened.id, expected_revision: 1, summary: "to lam", cue: "c", to_actor: "lam" }).ok, true);
  assert.equal(call(lam, "work_claim", { work_id: opened.id, lease_minutes: 10 }).ok, true);
  assert.match(call(aux, "work_handoff_cancel", { work_id: opened.id, expected_revision: 2, summary: "back" }).text, /needs no live claim/);
  now += 11 * 60_000;
  const cancelled = call(aux, "work_handoff_cancel", { work_id: opened.id, expected_revision: 2, summary: "back" });
  assert.equal(cancelled.ok, true, cancelled.text);
  assert.equal(cancelled.data.work.pending_handoff, undefined);
});

test("packets carry the exact recipient, and accept checks kind and actor", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const work = store.open({ operationId: "operation:open", topic: "Packet", goal: "g", surface: auxLocal }).work;
  const sent = new TrajectaRelay(store, auxLocal).handoff({ operationId: "operation:h", workId: work.id, expectedRevision: 1, summary: "to lam", provenance: [], openLoops: [], nextAction: null, target: "local", cue: "c", targetActor: "lam" });
  assert.equal(sent.packet.intendedActor, "lam");
  assert.throws(() => new TrajectaRelay(store, { ...auxLocal, session: "local:aux-2" }).accept(sent.packet, "operation:a1"), /intended for lam/);
  assert.equal(new TrajectaRelay(store, lamLocal).accept(sent.packet, "operation:a2").work.lastSurface.actor, "lam");
  const replayed = new TrajectaRelay(store, auxLocal).handoff({ operationId: "operation:h", workId: work.id, expectedRevision: 1, summary: "to lam", provenance: [], openLoops: [], nextAction: null, target: "local", cue: "c", targetActor: "lam" });
  assert.equal(replayed.packet.intendedActor, "lam", "a replayed handoff keeps its recipient");
  assert.equal(replayed.packet.resume.expectedRevision, 2, "and its own revision");
  assert.throws(() => new TrajectaRelay(store, lamLocal).accept(replayed.packet, "operation:a3"), /revision/i, "a stale packet fails CAS on accept");
});

test("the returned packet is the handoff commit's, even if the recipient resumes before it is rendered", () => {
  const root = tmp();
  const store = new TrajectaStore(root);
  const recipient = new TrajectaStore(root);
  const work = store.open({ operationId: "operation:open", topic: "Race", goal: "g", surface: auxLocal }).work;
  store.capture({ operationId: "operation:c1", workId: work.id, expectedRevision: 1, surface: auxLocal, kind: "progress", summary: "before handoff" });
  const capture = store.capture.bind(store);
  store.capture = ((input: Parameters<typeof capture>[0]) => {
    const result = capture(input);
    if (input.kind === "handoff") {
      // Another process: the recipient resumes and works before the sender renders its packet.
      recipient.resume({ operationId: "operation:fast-resume", workId: work.id, expectedRevision: result.work.revision, surface: lamLocal });
      recipient.capture({ operationId: "operation:after", workId: work.id, expectedRevision: result.work.revision + 1, surface: lamLocal, kind: "decision", summary: "later change" });
    }
    return result;
  }) as typeof store.capture;
  const sent = new TrajectaRelay(store, auxLocal).handoff({ operationId: "operation:h", workId: work.id, expectedRevision: 2, summary: "to lam", provenance: [], openLoops: [], nextAction: null, target: "local", cue: "c", targetActor: "lam" });
  assert.equal(recipient.getWork(work.id).revision, 5, "the race really happened");
  assert.equal(sent.packet.intendedActor, "lam");
  assert.equal(sent.packet.resume.expectedRevision, 3);
  assert.equal(sent.packet.work.revision, 3);
  assert.ok(sent.packet.recentDeltas.every((delta) => delta.revision <= 3), "no history after the handoff commit");
  assert.ok(!sent.packet.recentDeltas.some((delta) => delta.summary === "later change"));
});

test("startup: an exchange server must run as a registered actor on a registered surface; private stays actor-free", () => {
  const env = (extra: Record<string, string>) => ({ TRAJECTA_SURFACE_KIND: "local", TRAJECTA_SURFACE_SESSION: "local:x", ...extra }) as NodeJS.ProcessEnv;
  assert.throws(() => surfaceFrom(env({}), profile), /set TRAJECTA_ACTOR/);
  assert.throws(() => surfaceFrom(env({ TRAJECTA_ACTOR: "ty" }), profile), /not registered/);
  assert.throws(() => surfaceFrom(env({ TRAJECTA_ACTOR: "lam", TRAJECTA_SURFACE_KIND: "cloud" }), profile), /not registered for the cloud surface/);
  assert.equal(surfaceFrom(env({ TRAJECTA_ACTOR: "lam" }), profile).actor, "lam");
  assert.throws(() => surfaceFrom(env({ TRAJECTA_ACTOR: "aux" }), defaultProfile()), /has no actors/);
  assert.equal(surfaceFrom(env({}), defaultProfile()).actor, undefined);
  assert.throws(() => new WorkServer(new TrajectaStore(tmp()), auxLocal, { profile: defaultProfile() }), /must not carry one/);
  assert.throws(() => assertActor({ ...auxLocal, actor: undefined as never }, profile), /not registered/);
  const plain = new WorkServer(new TrajectaStore(tmp()), { kind: "local", name: "Aux", session: "local:aux" }, { profile: defaultProfile() });
  const result = (plain.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work_open", arguments: { topic: "t", goal: "g", actor: "lam" } } }) as any).result;
  assert.equal(result.isError, false, "an actor argument has no authority");
  assert.equal(result.structuredContent.work.last_surface.actor, undefined);
});

test("exchange-init writes the profile once and prints one MCP entry per actor surface", () => {
  const root = tmp();
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "exchange-init", root, ...args], { encoding: "utf8" });
  const first = run("--actors", "aux:cloud+local,lam:local", "--owner", "ty");
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(out.mcpServers), ["aux@cloud", "aux@local", "lam@local"]);
  assert.equal(out.mcpServers["lam@local"]["trajecta-exchange"].env.TRAJECTA_ACTOR, "lam");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, PROFILE_FILE), "utf8")).requireClaim, true);
  assert.equal(run("--actors", "aux:cloud+local,lam:local", "--owner", "ty").status, 0, "same profile again is fine");
  const changed = run("--actors", "aux:local", "--owner", "ty");
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /different profile/);
  const privateRoot = tmp();
  new TrajectaStore(privateRoot).open({ operationId: "operation:open", topic: "mine", goal: "private", surface: { kind: "local", name: "Aux", session: "local:aux" } });
  const over = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "exchange-init", privateRoot, "--actors", "aux:local", "--owner", "ty"], { encoding: "utf8" });
  assert.notEqual(over.status, 0, "an existing private store is never turned into an exchange");
  assert.match(over.stderr, /not empty/);
  assert.equal(fs.existsSync(path.join(privateRoot, PROFILE_FILE)), false);
});

test("claims in the exchange are fenced per actor, and ClaimConflict names the holder", () => {
  const { store, claims } = exchange();
  const work = store.open({ operationId: "operation:open", topic: "t", goal: "g", surface: auxLocal }).work;
  claims.claim("operation:c1", { workId: work.id, surface: auxLocal });
  assert.throws(() => store.capture({ operationId: "operation:x", workId: work.id, expectedRevision: 1, surface: { ...auxLocal, actor: "lam" }, kind: "progress", summary: "spoofed session", claimEpoch: 1 }), ClaimConflict, "same session, different actor is not the holder");
});
