# Exchange profile: shared work between agents, exact-recipient handoff

**Date:** 2026-09-29
**Builds on:** `2026-09-28-work-layers-from-awm.md` (the sequence after Phase 2: exchange profile + exact-recipient handoff) and `2026-09-29-phase3-cases-skills-claims.md` (claims, the admit hook)
**Status:** settled by Lam (E1–E4, 2026-09-29) and implemented. The settlement is recorded at the end.

## What this is, and what it is not

- **Private stays private.** Aux's work memory (today AWM) and Lam's (today LWM) remain separate stores. Each is its own root, read and written only by its owner's server. Nothing here reads, copies or indexes a private store.
- **The exchange is a third root** for shared work only: `TamVi-House/08-House-Server/house-data/exchange`. Work exists there only if an agent opens it there. Nothing is exported automatically from a private store.
- **Same engine.** The exchange runs the same trajecta-work-memory code with profile `exchange`. Each agent adds a second MCP server entry (`trajecta-exchange`) with `TRAJECTA_HOME` set to the exchange root and its own `TRAJECTA_ACTOR`. Its private server is unchanged.
- The owner (Ty) issues receipts for the exchange with the same CLI, pointed at the exchange root.

## Actors (E2)

- The exchange profile lists `actors: [{ id, displayName?, surfaces: ["cloud" | "local", …] }]`, the `owner`, and `requireClaim: true`. Set it up with `trajecta exchange-init <root> --actors aux:cloud+local,lam:local --owner ty`. The command writes the profile once, refuses to overwrite a different one, and prints one MCP entry per actor surface.
- **Startup rules:**
  - A server on a profile with actors requires `TRAJECTA_ACTOR`.
  - The actor must be registered.
  - The server's surface kind must be one of that actor's registered surfaces.
  - Otherwise the server refuses to start. `WorkServer` checks the same rules.
- `surface.actor` is always stamped by the server; no tool argument can pick or change it.
- On a profile without actors (private), `TRAJECTA_ACTOR` is refused and `Surface.actor` stays absent. Old data and operation digests are unchanged.
- **Trust model:** this is attribution between cooperating agents on one host, not authentication. It prevents mistakes, such as the wrong agent picking up work. It does not stop a hostile local user who can edit MCP config. Owner receipts stay CLI-only.

## Exact-recipient handoff, in core (E1)

- In the exchange, `work_handoff` needs `to_actor`: a registered actor who is not the sender. It also needs `to_surface` when the recipient has several surfaces; with exactly one registered surface, that surface is used.
- **Recording the handoff.** The handoff commit sets
  `WorkItem.pendingHandoff = { fromActor, toActor, toSurfaceKind, handoffDeltaId, revision, createdAt }`
  in the same core commit as the handoff delta. `handoffDeltaId` and `revision` point at that commit, and the delta carries `targetActor`. There is no separate domain journal and so no crash window: a handoff that crashes after reservation recovers with its binding.
- **Core rules while a handoff is pending** (enforced in `TrajectaStore`, independent of any fence):
  - `resume` only when `surface.actor === toActor` and `surface.kind === toSurfaceKind`. The resume commit clears `pendingHandoff`.
  - `capture` and `close` are refused for everyone, and a new handoff cannot be stacked on a pending one.
  - `handoff_cancel` (a new delta kind) is accepted only from `fromActor`. It clears `pendingHandoff` and sets the work back to active.
- **Packets.** `transfer` refuses to render a packet for any surface kind other than `toSurfaceKind`. The packet carries `intendedActor`, and `accept` checks both `intendedFor` (kind) and `intendedActor`. Core and packet are equally strict. `work_handoff` renders its packet from the exact work snapshot its handoff commit returned (`store.transferFrom`), with history only up to that revision, never from live state. So even if the recipient resumes before the sender renders, the packet keeps the handoff's recipient and revision; a stale packet then fails CAS on accept. A replayed handoff returns the same snapshot packet. `close` on a pending item is refused in the preflight, before the verifier runs.

## Claims in the exchange (E3): claim before resume

`requireClaim: true` (exchange only) makes the fence enforce:

| Mutation | Claim rule |
|---|---|
| open | none |
| ordinary capture | caller's own live claim, exact epoch |
| resume | caller's own live claim, exact epoch |
| close | caller's own live claim, exact epoch |
| handoff | **no** live claim at all |
| handoff_cancel | **no** live claim at all (and core: sender only) |

`work_claim` on a work item with a pending handoff is granted only to the exact recipient (`toActor` and `toSurfaceKind`). It decides on settled state, through the core's held-only read.

The protocol is: the sender holds the claim and works → the sender releases → the sender hands off (a pending handoff is set) → the recipient claims (only it can) → the recipient resumes with its `claim_epoch` (fence checks the claim, core checks the recipient; resume clears the pending handoff) → the recipient carries on under its live claim. No composite transaction is needed:

- Another actor claims between release and handoff: the handoff is refused. Safe.
- The recipient crashes after claiming but before resuming: the state is a pending handoff plus the recipient's claim. That is safe, and lease expiry clears it.
- The sender wants to cancel after the recipient has claimed: the fence refuses until the lease expires.

Private profiles keep `requireClaim` off; their behaviour is unchanged from Phase 3.

## Enforcement split (E4)

- **Core** owns the `pendingHandoff` transition invariants: set and clear, exact-recipient resume, capture/close blocked while in transit, sender-only cancel. These hold even in a raw `TrajectaStore`.
- **Server / profile** owns the registered-actor check and stamping.
- **Claim fence** owns the claim-required and no-live-claim policy.
- **Claim layer** owns the rule that only the pending recipient may claim.
- The admit context names the mutation (`capture` | `handoff` | `handoff_cancel` | `resume` | `close`) and carries the settled `pendingHandoff`, so the fence can treat handoff and cancel apart.
- **Deployment invariant:** a raw store on the exchange root obeys only the core `pendingHandoff` rules. It does not know the actor registry or `requireClaim`. The exchange root must be written only through exchange-profile servers (`runStdio` wires `claimFence(root, { requireClaim })`), except in explicit recovery or test mode.

## Compatibility

- `WorkItem.pendingHandoff?`, `Surface.actor?`, `Delta.targetActor?`, `TransferPacket.intendedActor?` and `CaptureDeltaInput.targetActor?` are additive. When absent, old data stays valid and old digests are unchanged.
- `handoff_cancel` is a delta-log capability bump, declared like `close`.
- MCP 0.6.0 adds `work_handoff_cancel` and `work_inbox`, and `to_actor` / `to_surface` on `work_handoff`. `work_list`, `work_get` and `work_context` show `pending_handoff`; the list and inbox add `for_me`.

## Settlement (Lam, 2026-09-29)

- **E1 — yes, core state with the exact recipient tuple.** `{fromActor, toActor, toSurfaceKind, handoffDeltaId, revision, createdAt}`, set and cleared in single commits. No stacking; the packet is as strict as core.
- **E2 — yes, server-stamped actor.** `TRAJECTA_ACTOR` is required on an exchange profile, must be registered, and the surface kind must be registered for that actor. Arguments carry no authority. This is attribution, not authentication.
- **E3 — yes, `requireClaim`, with claim-before-resume.** Resume needs a claim too. Handoff and cancel need no live claim. On pending work, only the recipient can claim. The admit context names the mutation.
- **E4 — yes, the core/fence split as above.** A raw store obeys only the core rules; the deployment invariant is stated.

## Out of scope

- Moving AWM/LWM onto TWM (Phase 4).
- Copying work between a private store and the exchange.
- Cryptographic actor identity.
- Hosts other than the Mac mini sharing one root; the root lock is same-host.
