/**
 * Receipts: typed authorisations, kept in one domain journal on the shared
 * operation ledger (decision 3 in docs/specs/2026-09-28-work-layers-from-awm.md).
 *
 * Same ledger machinery for every purpose, different typed semantics:
 *
 * - `trajecta.work-close-receipt/v1`, purpose `work_close` (see store.close)
 * - `trajecta.owner-approval-receipt/v1`, purpose `incident_promotion`
 *
 * A receipt of one purpose can never authorise another. Receipts are issued
 * by the owner through the CLI (`trajecta approve-…`), never through MCP, and
 * are resolved by reference. Resolution reads the projection, which is
 * replaced atomically, so it needs no lock and can run outside a mutation.
 */
import crypto from "node:crypto";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { canonicalStoreDigest } from "./store.ts";
import type { WorkCloseReceipt } from "./types.ts";

export interface OwnerApprovalReceipt {
  schema: "trajecta.owner-approval-receipt/v1";
  id: string;
  purpose: "incident_promotion";
  incidentId: string;
  /** invariantDigest() of the exact rule being accepted. */
  invariantDigest: string;
  authority: "owner";
  outcome: "approved";
  provenance: string[];
  issuedAt: string;
  expiresAt?: string;
}

/** Owner approval to make one validated skill version the active one. */
export interface SkillActivationReceipt {
  schema: "trajecta.owner-approval-receipt/v1";
  id: string;
  purpose: "skill_activation";
  skillId: string;
  versionId: string;
  /** The active version this one replaces (its parent); null for a skill's first activation. */
  expectedParentVersionId: string | null;
  /** The skill's pointer epoch when the owner approved; any pointer move invalidates the receipt. */
  expectedPointerEpoch: number;
  decisionId: string;
  contentDigest: string;
  authority: "owner";
  outcome: "approved";
  provenance: string[];
  issuedAt: string;
  expiresAt?: string;
}

/** Owner approval to move a skill's active pointer back to a version that was active before. */
export interface SkillRollbackReceipt {
  schema: "trajecta.owner-approval-receipt/v1";
  id: string;
  purpose: "skill_rollback";
  skillId: string;
  fromVersionId: string;
  toVersionId: string;
  expectedPointerEpoch: number;
  reasonDigest: string;
  authority: "owner";
  outcome: "approved";
  provenance: string[];
  issuedAt: string;
  expiresAt?: string;
}

export type Receipt = WorkCloseReceipt | OwnerApprovalReceipt | SkillActivationReceipt | SkillRollbackReceipt;

export interface ReceiptIssued extends JournalEvent {
  type: "issued";
  receipt: Receipt;
}

export interface ReceiptIndex {
  byId: Record<string, Receipt>;
}

const RECEIPT_ID = /^receipt:[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isReceipt(value: unknown): value is Receipt {
  const receipt = value as Partial<Receipt> | null;
  if (!receipt || typeof receipt.id !== "string" || !RECEIPT_ID.test(receipt.id) || typeof receipt.issuedAt !== "string") return false;
  if (receipt.schema === "trajecta.work-close-receipt/v1") return receipt.purpose === "work_close";
  if (receipt.schema === "trajecta.owner-approval-receipt/v1") return ["incident_promotion", "skill_activation", "skill_rollback"].includes(receipt.purpose as string);
  return false;
}

export const RECEIPTS: DomainSpec<ReceiptIndex, ReceiptIssued> = {
  name: "receipts",
  projectionFile: "receipt-index.json",
  projectionSchema: "trajecta.receipt-index/v1",
  empty: () => ({ byId: {} }),
  apply(index, event) {
    index.byId[event.receipt.id] = event.receipt;
    return index;
  },
  isEvent: (value: unknown): value is ReceiptIssued => {
    const event = value as Partial<ReceiptIssued> | null;
    return Boolean(event) && event!.type === "issued" && typeof event!.id === "string" && isReceipt(event!.receipt);
  },
};

export function receiptJournal(root: string, clock?: () => Date) {
  return new DomainJournal(root, RECEIPTS, clock);
}

/** Record a receipt the owner issued. Same id twice with the same body is a no-op. */
export function issueReceipt(root: string, receipt: Receipt, clock?: () => Date) {
  if (!isReceipt(receipt)) throw new Error("Not a valid receipt");
  const journal = receiptJournal(root, clock);
  const operationId = `operation:issue-${receipt.id.slice("receipt:".length)}`;
  return journal.append(operationId, receipt, (index) => {
    if (Object.hasOwn(index.byId, receipt.id)) throw new Error(`Receipt ${receipt.id} already exists`);
    return { type: "issued" as const, receipt };
  }).event.receipt;
}

export function newReceiptId() {
  return `receipt:${crypto.randomUUID()}`;
}

/** Resolver for TrajectaStore / LearningLayer: look a receipt up by reference. */
export function receiptResolver(root: string) {
  const journal = receiptJournal(root);
  return (reference: string): Receipt | null => {
    const byId = journal.read().byId;
    return Object.hasOwn(byId, reference) ? structuredClone(byId[reference]) : null;
  };
}

/** Digest an owner-approval receipt must carry for one incident's rule. */
export function invariantDigest(rule: { incidentId: string; cluster: string; preventionRule: string; violatedInvariant: string }) {
  return canonicalStoreDigest({
    incidentId: rule.incidentId,
    cluster: rule.cluster,
    preventionRule: rule.preventionRule.trim(),
    violatedInvariant: rule.violatedInvariant.trim(),
  });
}

export class ApprovalRejected extends Error {
  constructor(reason: string) {
    super(`Promotion approval rejected: ${reason}`);
    this.name = "ApprovalRejected";
  }
}

export function assertOwnerApproval(value: unknown, expected: { reference: string; incidentId: string; digest: string }, now: Date) {
  const receipt = value as Partial<OwnerApprovalReceipt> | null | undefined;
  if (!receipt) throw new ApprovalRejected("no receipt found for this reference");
  if (receipt.purpose !== "incident_promotion") throw new ApprovalRejected(`purpose ${String(receipt.purpose)} cannot promote an incident`);
  if (receipt.schema !== "trajecta.owner-approval-receipt/v1") throw new ApprovalRejected("unsupported schema");
  if (receipt.id !== expected.reference) throw new ApprovalRejected("receipt id does not match the reference");
  if (receipt.incidentId !== expected.incidentId) throw new ApprovalRejected("receipt is for a different incident");
  if (receipt.invariantDigest !== expected.digest) throw new ApprovalRejected("receipt approves a different rule");
  if (receipt.authority !== "owner") throw new ApprovalRejected("only the owner can approve a promotion");
  if (receipt.outcome !== "approved") throw new ApprovalRejected("receipt is not an approval");
  const issued = Date.parse(String(receipt.issuedAt));
  if (!Number.isFinite(issued) || issued > now.getTime()) throw new ApprovalRejected("receipt issue time is invalid or in the future");
  if (receipt.expiresAt !== undefined && !(Date.parse(receipt.expiresAt) > now.getTime())) throw new ApprovalRejected("receipt has expired");
}

export class SkillApprovalRejected extends Error {
  constructor(reason: string) {
    super(`Skill approval rejected: ${reason}`);
    this.name = "SkillApprovalRejected";
  }
}

/** Digest a rollback receipt carries for its reason. */
export function reasonDigest(reason: string) {
  return canonicalStoreDigest({ reason: reason.trim() });
}

function assertOwnerCommon(receipt: Record<string, unknown>, reference: string, now: Date, reject: (reason: string) => Error) {
  if (receipt.schema !== "trajecta.owner-approval-receipt/v1") throw reject("unsupported schema");
  if (receipt.id !== reference) throw reject("receipt id does not match the reference");
  if (receipt.authority !== "owner") throw reject("only the owner can approve this");
  if (receipt.outcome !== "approved") throw reject("receipt is not an approval");
  const issued = Date.parse(String(receipt.issuedAt));
  if (!Number.isFinite(issued) || issued > now.getTime()) throw reject("receipt issue time is invalid or in the future");
  if (receipt.expiresAt !== undefined && !(Date.parse(String(receipt.expiresAt)) > now.getTime())) throw reject("receipt has expired");
}

export function assertSkillActivation(value: unknown, expected: { reference: string; skillId: string; versionId: string; expectedParentVersionId: string | null; expectedPointerEpoch: number; decisionId: string; contentDigest: string }, now: Date) {
  const receipt = value as Record<string, unknown> | null | undefined;
  const reject = (reason: string) => new SkillApprovalRejected(reason);
  if (!receipt) throw reject("no receipt found for this reference");
  if (receipt.purpose !== "skill_activation") throw reject(`purpose ${String(receipt.purpose)} cannot activate a skill`);
  assertOwnerCommon(receipt, expected.reference, now, reject);
  if (receipt.skillId !== expected.skillId || receipt.versionId !== expected.versionId) throw reject("receipt is for a different skill version");
  if (receipt.expectedParentVersionId !== expected.expectedParentVersionId) throw reject("receipt expects a different active version");
  if (receipt.expectedPointerEpoch !== expected.expectedPointerEpoch) throw reject(`receipt was issued at pointer epoch ${String(receipt.expectedPointerEpoch)}; the pointer is now at epoch ${expected.expectedPointerEpoch}`);
  if (receipt.decisionId !== expected.decisionId) throw reject("receipt names a different validation");
  if (receipt.contentDigest !== expected.contentDigest) throw reject("receipt approves different content");
}

export function assertSkillRollback(value: unknown, expected: { reference: string; skillId: string; fromVersionId: string; toVersionId: string; expectedPointerEpoch: number; reasonDigest: string }, now: Date) {
  const receipt = value as Record<string, unknown> | null | undefined;
  const reject = (reason: string) => new SkillApprovalRejected(reason);
  if (!receipt) throw reject("no receipt found for this reference");
  if (receipt.purpose !== "skill_rollback") throw reject(`purpose ${String(receipt.purpose)} cannot roll a skill back`);
  assertOwnerCommon(receipt, expected.reference, now, reject);
  if (receipt.skillId !== expected.skillId || receipt.fromVersionId !== expected.fromVersionId || receipt.toVersionId !== expected.toVersionId) {
    throw reject("receipt is for a different rollback");
  }
  if (receipt.expectedPointerEpoch !== expected.expectedPointerEpoch) throw reject(`receipt was issued at pointer epoch ${String(receipt.expectedPointerEpoch)}; the pointer is now at epoch ${expected.expectedPointerEpoch}`);
  if (receipt.reasonDigest !== expected.reasonDigest) throw reject("receipt approves a different reason");
}
