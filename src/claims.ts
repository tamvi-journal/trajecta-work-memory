/**
 * Work claims: exclusive execution of one work item across surfaces
 * (Phase 3 §C, docs/specs/2026-09-29-phase3-cases-skills-claims.md).
 *
 * - One live claim per work item: holder (surface kind, name, session),
 *   epoch, lease expiry. A lease ends on its own; no owner step, so a dead
 *   session cannot wedge the work.
 * - The epoch rises on every acquisition and never resets.
 * - The fence (`claimFence`) is the store's admission check: while a live
 *   claim exists, capture/resume/close from anyone but the holder are refused,
 *   and the holder must pass the exact epoch. With no live claim, passing an
 *   epoch is refused too (the caller's claim was released or expired).
 * - Claims are explicit (`claim` / `release`). Handoff and resume do not move
 *   a claim in this phase: that would need one crash-safe transaction over
 *   the store and this journal (Lam's settlement, D3).
 */
import crypto from "node:crypto";
import { DomainJournal, type DomainSpec, type JournalEvent } from "./journal.ts";
import { own } from "./clusters.ts";
import { withRootWriteLock, type LockOptions } from "./lock.ts";
import type { TrajectaStore } from "./store.ts";
import type { AdmitContext, Surface } from "./types.ts";

export interface LiveClaim {
  claimId: string;
  epoch: number;
  holder: Surface;
  acquiredAt: string;
  expiresAt: string;
}

export interface ClaimEvent extends JournalEvent {
  type: "acquired" | "renewed" | "released";
  workId: string;
  claimId: string;
  epoch: number;
  holder: Surface;
  expiresAt: string | null;
}

export interface ClaimIndex {
  byWork: Record<string, { epoch: number; live: LiveClaim | null }>;
}

export const CLAIMS: DomainSpec<ClaimIndex, ClaimEvent> = {
  name: "claims",
  projectionFile: "claim-index.json",
  projectionSchema: "trajecta.claim-index/v1",
  empty: () => ({ byWork: {} }),
  apply(index, event) {
    const entry = own(index.byWork, event.workId) ?? { epoch: 0, live: null };
    if (event.type === "released") entry.live = null;
    else {
      entry.epoch = Math.max(entry.epoch, event.epoch);
      entry.live = {
        claimId: event.claimId, epoch: event.epoch, holder: event.holder,
        acquiredAt: event.type === "renewed" && entry.live ? entry.live.acquiredAt : event.recordedAt,
        expiresAt: event.expiresAt!,
      };
    }
    index.byWork[event.workId] = entry;
    return index;
  },
  isEvent: (value: unknown): value is ClaimEvent => {
    const event = value as Partial<ClaimEvent> | null;
    return Boolean(event) && ["acquired", "renewed", "released"].includes(event!.type as string)
      && typeof event!.workId === "string" && Number.isInteger(event!.epoch) && typeof event!.claimId === "string";
  },
};

export class ClaimConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimConflict";
  }
}

const sameHolder = (left: Surface, right: Surface) => left.kind === right.kind && left.name === right.name && left.session === right.session;

function liveAt(entry: { live: LiveClaim | null } | undefined, now: Date) {
  const live = entry?.live;
  return live && Date.parse(live.expiresAt) > now.getTime() ? live : null;
}

export interface ClaimOptions {
  clock?: () => Date;
  lock?: LockOptions;
  defaultLeaseMinutes?: number;
  maxLeaseMinutes?: number;
}

export class ClaimLayer {
  readonly journal: DomainJournal<ClaimIndex, ClaimEvent>;
  private readonly store: TrajectaStore;
  private readonly clock: () => Date;
  private readonly options: ClaimOptions;

  constructor(store: TrajectaStore, options: ClaimOptions = {}) {
    this.store = store;
    this.clock = options.clock ?? (() => new Date());
    this.options = options;
    this.journal = new DomainJournal(store.root, CLAIMS, this.clock, undefined, options.lock);
  }

  private lease(minutes: unknown) {
    const fallback = this.options.defaultLeaseMinutes ?? 120;
    const max = this.options.maxLeaseMinutes ?? 720;
    const value = minutes === undefined ? fallback : minutes;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`lease_minutes must be an integer in 1..${max}`);
    return value as number;
  }

  /** The live claim on a work item, or null. */
  current(workId: string): LiveClaim | null {
    return liveAt(own(this.journal.read().byWork, workId), this.clock());
  }

  /** Acquire a claim, or renew the caller's own live claim (same epoch). */
  claim(operationId: string, input: { workId: string; surface: Surface; leaseMinutes?: number }) {
    const minutes = this.lease(input.leaseMinutes);
    const request = { workId: input.workId, holder: input.surface, leaseMinutes: minutes };
    return withRootWriteLock(this.store.root, () => {
      const replayed = this.journal.replayHeld(operationId, request);
      if (replayed) return { ...replayed, replayed: true };
      // Settle any reserved store operation first (e.g. a close that crashed
      // after its reservation), so a claim is only granted on settled state.
      const work = this.store.getWorkSettledHeld(input.workId);
      if (["complete", "abandoned"].includes(work.status)) throw new Error("Closed work cannot be claimed");
      return { ...this.journal.appendHeld(operationId, request, (index) => {
        const now = this.clock();
        const entry = own(index.byWork, work.id);
        const live = liveAt(entry, now);
        const expiresAt = new Date(now.getTime() + minutes * 60_000).toISOString();
        if (live && !sameHolder(live.holder, input.surface)) {
          throw new ClaimConflict(`Work is claimed by ${live.holder.kind}:${live.holder.name} (${live.holder.session}) until ${live.expiresAt}`);
        }
        if (live) return { type: "renewed" as const, workId: work.id, claimId: live.claimId, epoch: live.epoch, holder: input.surface, expiresAt };
        return { type: "acquired" as const, workId: work.id, claimId: `claim:${crypto.randomUUID()}`, epoch: (entry?.epoch ?? 0) + 1, holder: input.surface, expiresAt };
      }), replayed: false };
    }, this.options.lock);
  }

  /** Release the caller's live claim. Holder and exact epoch must match. */
  release(operationId: string, input: { workId: string; surface: Surface; claimEpoch: number }) {
    const request = { workId: input.workId, holder: input.surface, claimEpoch: input.claimEpoch };
    return withRootWriteLock(this.store.root, () => {
      const replayed = this.journal.replayHeld(operationId, request);
      if (replayed) return { ...replayed, replayed: true };
      return { ...this.journal.appendHeld(operationId, request, (index) => {
        const live = liveAt(own(index.byWork, input.workId), this.clock());
        if (!live) throw new ClaimConflict("Work has no live claim (released or expired)");
        if (!sameHolder(live.holder, input.surface)) throw new ClaimConflict("Only the holder can release a claim");
        if (live.epoch !== input.claimEpoch) throw new ClaimConflict(`Stale claim epoch ${input.claimEpoch}; the live claim is epoch ${live.epoch}`);
        return { type: "released" as const, workId: input.workId, claimId: live.claimId, epoch: live.epoch, holder: input.surface, expiresAt: null };
      }), replayed: false };
    }, this.options.lock);
  }
}

/**
 * The store's admission check for claims. Pure: reads the claims projection
 * under the root lock the store already holds and never writes a claim.
 */
export function claimFence(root: string, options: { clock?: () => Date; lock?: LockOptions } = {}) {
  const journal = new DomainJournal(root, CLAIMS, options.clock, undefined, options.lock);
  const clock = options.clock ?? (() => new Date());
  return (context: AdmitContext) => {
    const live = liveAt(own(journal.readHeld().byWork, context.workId), clock());
    if (!live) {
      if (context.claimEpoch !== undefined) throw new ClaimConflict(`claim_epoch ${context.claimEpoch} given, but the work has no live claim (released or expired)`);
      return;
    }
    if (!sameHolder(live.holder, context.surface)) {
      throw new ClaimConflict(`Work is claimed by ${live.holder.kind}:${live.holder.name} (${live.holder.session}) until ${live.expiresAt}; ${context.kind} refused`);
    }
    if (context.claimEpoch !== live.epoch) {
      throw new ClaimConflict(context.claimEpoch === undefined
        ? `You hold claim epoch ${live.epoch}; pass claim_epoch to ${context.kind}`
        : `Stale claim epoch ${context.claimEpoch}; the live claim is epoch ${live.epoch}`);
    }
  };
}
