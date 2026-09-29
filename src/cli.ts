#!/usr/bin/env -S node --experimental-strip-types
import process from "node:process";
import { closeIntentDigest, TrajectaStore, validateCloseInput } from "./store.ts";
import { importLifecycle } from "./import-lifecycle.ts";
import { defaultRoot } from "./mcp.ts";
import { INCIDENTS } from "./learning.ts";
import { DomainJournal } from "./journal.ts";
import { invariantDigest, issueReceipt, newReceiptId, receiptJournal, type OwnerApprovalReceipt } from "./receipts.ts";
import { own } from "./clusters.ts";
import type { WorkCloseReceipt } from "./types.ts";

const [command, ...rest] = process.argv.slice(2);
const root = defaultRoot(process.env);
const store = new TrajectaStore(root);

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function flags(args: string[]) {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      named[key] = value;
      index += 1;
    } else positional.push(arg);
  }
  return { positional, named };
}

function list(value: string | undefined) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function expiry(named: Record<string, string>, now: Date) {
  if (!named["expires-hours"]) return {};
  const hours = Number(named["expires-hours"]);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--expires-hours must be a positive number");
  return { expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString() };
}

const HELP = `Trajecta — keep the work, skip the handoff.

Store: ${root}  (set TRAJECTA_HOME to use another)

Commands:
  list
  route <cue>
  packet <work-id> <cloud|local> <cue>
  import-awm <source-root>
  import-lwm <source-root>
  receipts                                  list issued receipts

Owner approvals (run these yourself; agents cannot issue receipts over MCP):
  approve-promotion <incident-id> [--expires-hours N] [--provenance a:b,c:d]
      Approve turning a learning_candidate incident into an accepted rule.
  approve-close <work-id> <complete|abandoned> --summary "..." [--provenance a:b,c:d]
      [--evidence-class test|review|owner-ack] [--authority owner] [--expires-hours N]
      Approve closing a work item at its current revision with exactly this
      summary and provenance.
`;

try {
  // Only the approval commands take --options; every other command keeps its
  // arguments verbatim (a cue may well contain "--").
  const { positional: args, named } = command?.startsWith("approve-") ? flags(rest) : { positional: rest, named: {} as Record<string, string> };
  if (command === "list") print(store.list());
  else if (command === "route") print(store.route(args.join(" ")));
  else if (command === "packet") {
    const [workId, target, ...cue] = args;
    if (!workId || !["cloud", "local"].includes(target)) throw new Error("Usage: trajecta packet <work-id> <cloud|local> <cue>");
    print(store.transfer(workId, cue.join(" "), target as "cloud" | "local"));
  } else if (command === "import-awm" || command === "import-lwm") {
    const [source] = args;
    if (!source) throw new Error(`Usage: trajecta ${command} <source-root>   (the folder that holds state/ and config/)`);
    const report = importLifecycle(store, source, command === "import-awm" ? "awm" : "lwm");
    print({ ...report, registry: report.registry ? { clusters: Object.keys(report.registry.clusters) } : null });
  } else if (command === "receipts") {
    print(Object.values(receiptJournal(root).read().byId));
  } else if (command === "approve-promotion") {
    const [incidentId] = args;
    if (!incidentId) throw new Error("Usage: trajecta approve-promotion <incident-id>");
    const incident = own(new DomainJournal(root, INCIDENTS).read().byId, incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} not found`);
    if (incident.tier !== "learning_candidate") throw new Error(`Only a learning_candidate can be promoted; this incident is ${incident.tier}`);
    const now = new Date();
    const receipt: OwnerApprovalReceipt = {
      schema: "trajecta.owner-approval-receipt/v1",
      id: newReceiptId(),
      purpose: "incident_promotion",
      incidentId,
      invariantDigest: invariantDigest({ incidentId, cluster: incident.cluster, preventionRule: incident.preventionRule, violatedInvariant: incident.violatedInvariant }),
      authority: "owner",
      outcome: "approved",
      provenance: list(named.provenance),
      issuedAt: now.toISOString(),
      ...expiry(named, now),
    };
    issueReceipt(root, receipt);
    print({ approval_ref: receipt.id, incident_id: incidentId, rule: incident.preventionRule, cluster: incident.cluster, next: "Give approval_ref to the agent for work_promote_incident." });
  } else if (command === "approve-close") {
    const [workId, status] = args;
    if (!workId || (status !== "complete" && status !== "abandoned") || !named.summary) {
      throw new Error("Usage: trajecta approve-close <work-id> <complete|abandoned> --summary \"...\" [--provenance a:b,c:d]");
    }
    const work = store.getWork(workId);
    const provenance = list(named.provenance);
    // Refuse an approval that work_close could never accept.
    validateCloseInput({
      operationId: "operation:approval-check", workId, expectedRevision: work.revision,
      surface: { kind: "local", name: "owner", session: "local:cli" }, status, summary: named.summary,
      verificationRef: "receipt:approval-check", provenance,
    });
    if (status === "complete" && work.openLoops.length) {
      throw new Error(`Work still has ${work.openLoops.length} open loop(s); complete close would be refused. Resolve them or approve an abandoned close.`);
    }
    const now = new Date();
    const receipt: WorkCloseReceipt = {
      schema: "trajecta.work-close-receipt/v1",
      id: newReceiptId(),
      purpose: "work_close",
      workId,
      expectedRevision: work.revision,
      status,
      intentDigest: closeIntentDigest({ workId, expectedRevision: work.revision, status, summary: named.summary, provenance }),
      authority: named.authority ?? "owner",
      evidenceClass: named["evidence-class"] ?? (status === "complete" ? "owner-ack" : ""),
      outcome: "approved",
      issuedAt: now.toISOString(),
      ...expiry(named, now),
    };
    issueReceipt(root, receipt);
    print({
      verification_ref: receipt.id, work_id: workId, expected_revision: work.revision, status, summary: named.summary.trim(), provenance,
      next: "The agent must call work_close with exactly this revision, status, summary and provenance.",
    });
  } else {
    process.stdout.write(HELP);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
