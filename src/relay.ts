import type { Surface, SurfaceKind, TransferPacket } from "./types.ts";
import { TrajectaStore } from "./store.ts";

export interface TransportReceipt {
  level: "packet-created" | "transport-accepted" | "target-received" | "target-resumed" | "outcome-verified";
  reference: string;
}

export interface HandoffInput {
  operationId: string;
  workId: string;
  expectedRevision: number;
  summary: string;
  provenance: string[];
  openLoops: string[];
  nextAction: string | null;
  target: SurfaceKind;
  cue: string;
  maxBytes?: number;
  claimEpoch?: number;
  /** Exchange: the exact recipient actor. With an actor, the target may be the same surface kind. */
  targetActor?: string;
}

export class TrajectaRelay {
  readonly store: TrajectaStore;
  readonly surface: Surface;
  constructor(store: TrajectaStore, surface: Surface) {
    this.store = store;
    this.surface = surface;
  }

  handoff(input: HandoffInput) {
    if (input.target === this.surface.kind && input.targetActor === undefined) throw new Error("A handoff target must be a different surface kind");
    const captured = this.store.capture({
      operationId: input.operationId,
      workId: input.workId,
      expectedRevision: input.expectedRevision,
      surface: this.surface,
      kind: "handoff",
      summary: input.summary,
      provenance: input.provenance,
      openLoops: input.openLoops,
      nextAction: input.nextAction,
      targetSurface: input.target,
      ...(input.targetActor !== undefined ? { targetActor: input.targetActor } : {}),
      ...(input.claimEpoch !== undefined ? { claimEpoch: input.claimEpoch } : {}),
    });
    const packet = this.store.transfer(input.workId, input.cue, input.target, input.maxBytes);
    const receipt: TransportReceipt = { level: "packet-created", reference: packet.packetId };
    return { packet, receipt, work: captured.work };
  }

  accept(packet: TransferPacket, operationId: string, instruction?: string, claimEpoch?: number) {
    if (packet.schema !== "trajecta.transfer/v1") throw new Error("Unsupported transfer packet schema");
    if (packet.intendedFor !== this.surface.kind) throw new Error("Transfer packet is intended for a different surface kind");
    if (packet.intendedActor !== undefined && packet.intendedActor !== this.surface.actor) throw new Error(`Transfer packet is intended for ${packet.intendedActor}`);
    const resumed = this.store.resume({
      operationId,
      workId: packet.work.id,
      expectedRevision: packet.resume.expectedRevision,
      surface: this.surface,
      instruction,
      ...(claimEpoch !== undefined ? { claimEpoch } : {}),
    });
    const receipt: TransportReceipt = { level: "target-resumed", reference: resumed.delta.id };
    return { ...resumed, receipt };
  }
}
