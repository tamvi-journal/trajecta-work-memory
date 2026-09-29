export type SurfaceKind = "cloud" | "local";

export interface Surface {
  kind: SurfaceKind;
  name: string;
  session: string;
  /** Registered actor id, stamped by an exchange-profile server. Absent on private stores. */
  actor?: string;
}

/** A handoff in transit to one exact recipient (exchange profile). Core state. */
export interface PendingHandoff {
  fromActor: string;
  toActor: string;
  toSurfaceKind: SurfaceKind;
  handoffDeltaId: string;
  revision: number;
  createdAt: string;
}

export type WorkStatus = "active" | "waiting" | "blocked" | "complete" | "abandoned";
export type BranchStatus = "exploring" | "parked" | "merged";
export type DeltaKind =
  | "instruction"
  | "decision"
  | "progress"
  | "blocker"
  | "correction"
  | "next_action"
  | "branch_open"
  | "branch_park"
  | "synthesis"
  | "handoff"
  | "outcome"
  | "contract_anchor"
  | "handoff_cancel";

export interface BranchInput {
  label: string;
  purpose: string;
  cues: string[];
  returnPoint: string;
}

export interface Branch extends BranchInput {
  id: string;
  status: BranchStatus;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  topic: string;
  goal: string;
  instruction: string | null;
  status: WorkStatus;
  revision: number;
  activeBranchId: string | null;
  branches: Branch[];
  openLoops: string[];
  nextAction: string | null;
  lastSurface: Surface;
  createdAt: string;
  updatedAt: string;
  /** Set by an actor-addressed handoff, cleared by the recipient's resume or the sender's cancel. */
  pendingHandoff?: PendingHandoff | null;
}

export interface Delta {
  id: string;
  operationId: string;
  workId: string;
  revision: number;
  kind: DeltaKind | "open" | "resume" | "close";
  /** Recipient actor of an actor-addressed handoff. */
  targetActor?: string;
  summary: string;
  surface: Surface;
  branchId: string | null;
  targetSurface: SurfaceKind | null;
  provenance: string[];
  createdAt: string;
  contractVersion?: number;
  previousContractId?: string | null;
}

export interface OpenWorkInput {
  operationId: string;
  topic: string;
  goal: string;
  surface: Surface;
  instruction?: string;
  initialBranch?: BranchInput;
}

export interface CaptureDeltaInput {
  operationId: string;
  workId: string;
  expectedRevision: number;
  surface: Surface;
  kind: DeltaKind;
  summary: string;
  provenance?: string[];
  branchId?: string;
  branch?: BranchInput;
  openLoops?: string[];
  nextAction?: string | null;
  targetSurface?: SurfaceKind;
  /** Exchange: the exact recipient actor of a handoff. */
  targetActor?: string;
  /** Current claim epoch; required only while a live claim exists (claim fence). */
  claimEpoch?: number;
}

export interface ResumeWorkInput {
  operationId: string;
  workId: string;
  expectedRevision: number;
  surface: Surface;
  instruction?: string;
  claimEpoch?: number;
}

/** What the store's admission check (the claim fence) sees. */
export interface AdmitContext {
  workId: string;
  surface: Surface;
  /** capture = any ordinary capture kind; handoff / handoff_cancel are named so the fence can treat them apart. */
  kind: "capture" | "handoff" | "handoff_cancel" | "resume" | "close";
  claimEpoch?: number;
  /** The work item's pending handoff on settled state, if any. */
  pendingHandoff: PendingHandoff | null;
}

export interface TransferPacket {
  schema: "trajecta.transfer/v1";
  packetId: string;
  createdAt: string;
  cue: string;
  from: Surface;
  intendedFor: SurfaceKind;
  /** Exchange: the exact recipient actor while a handoff is pending. */
  intendedActor?: string;
  work: {
    id: string;
    topic: string;
    goal: string;
    instruction: string | null;
    status: WorkStatus;
    revision: number;
    openLoops: string[];
    nextAction: string | null;
  };
  activeBranch: Branch | null;
  recentDeltas: Array<Pick<Delta, "id" | "revision" | "kind" | "summary" | "provenance" | "createdAt">>;
  contractAnchor?: Pick<Delta, "id" | "contractVersion" | "summary" | "provenance" | "createdAt">;
  resume: {
    expectedRevision: number;
    rule: string;
  };
  budget: {
    maxBytes: number;
    usedBytes: number;
    truncated: boolean;
  };
}

export interface RouteMatch {
  workId: string;
  topic: string;
  score: number;
  matchedCues: string[];
  revision: number;
  updatedAt: string;
}

export type TerminalStatus = "complete" | "abandoned";

/**
 * Typed authorisation for closing one work item. Issued by a verifier the
 * application trusts, resolved by reference; never accepted from the caller
 * inline. Purpose `work_close` only: it cannot promote an incident, and an
 * incident-promotion receipt cannot close work.
 */
export interface WorkCloseReceipt {
  schema: "trajecta.work-close-receipt/v1";
  id: string;
  purpose: "work_close";
  workId: string;
  expectedRevision: number;
  status: TerminalStatus;
  /** closeIntentDigest() of the exact close request. */
  intentDigest: string;
  /** Who authorised it, e.g. "owner" or "verifier:ci". */
  authority: string;
  /** What backs it, e.g. "test", "review", "owner-ack". Required for complete. */
  evidenceClass: string;
  outcome: "approved";
  issuedAt: string;
  expiresAt?: string;
}

export interface CloseWorkInput {
  operationId: string;
  workId: string;
  expectedRevision: number;
  surface: Surface;
  status: TerminalStatus;
  summary: string;
  verificationRef: string;
  provenance: string[];
  claimEpoch?: number;
}
