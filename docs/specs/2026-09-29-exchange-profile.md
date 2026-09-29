# Exchange profile: shared work between agents, exact-recipient handoff

**Date:** 2026-09-29
**Builds on:** `2026-09-28-work-layers-from-awm.md` (sequence after Phase 2: exchange profile + exact-recipient handoff), `2026-09-29-phase3-cases-skills-claims.md` (claims, admit hook)
**Status:** proposal. Decisions E1–E4 need Lam's settlement before code.

## What this is, and what it is not

- **Private stays private.** Aux's work memory (today AWM) and Lam's (today LWM) remain separate stores. Each is its own root, read and written only by its owner's server. Nothing here reads, copies or indexes a private store.
- **Exchange is a third root** for shared work only: `TamVi-House/08-House-Server/house-data/exchange`. Work exists there only if an agent opens it there. No automatic export from a private store.
- **Same engine.** The exchange runs the same trajecta-work-memory code with profile `exchange`. Each agent adds a second MCP server entry (`trajecta-exchange`) pointing `TRAJECTA_HOME` at the exchange root, with its own actor id. Its private server is untouched.
- The owner (Ty) issues receipts for the exchange with the same CLI, pointed at the exchange root.

## Actors

- The exchange profile lists actors: `{ id: "aux" | "lam" | …, displayName, surfaces: ["cloud", "local"] }` and `owner: "ty"`.
- The server's actor comes from its environment (`TRAJECTA_ACTOR`) and must be in the profile's list, or the server refuses to start. It is stamped on every surface the server writes (`surface.actor`), never taken from tool arguments.
- `Surface` gains an optional `actor`. Stores without actors (private roots) are unchanged; digests of existing operations are unchanged because the field is absent there.
- **Trust model (E2):** this is attribution between cooperating agents on one machine, not authentication. Anyone who can edit an MCP config can claim any registered actor. It protects against mistakes (the wrong agent picking up work), not against a hostile local user. Owner receipts stay CLI-only as before.

## Exact-recipient handoff

- `work_handoff(work_id, expected_revision, to_actor, summary, cue, …)` in the exchange must name `to_actor`: a registered actor, not the sender.
- The handoff is recorded **in the work item itself**, in the same core commit as the handoff delta (E1):
  `pendingHandoff: { fromActor, toActor, handoffDeltaId, revision, createdAt } | null`.
  One durable commit, so there is no crash window between "handoff written" and "recipient bound".
- While `pendingHandoff` is set:
  - `resume` is admitted only for `toActor`; it clears `pendingHandoff` in the same commit.
  - `capture` and `close` are refused for everyone (the work is in transit), except `handoff_cancel` by `fromActor`.
  - `work_handoff_cancel(work_id, expected_revision)` by the sender clears it (one commit, delta kind `handoff_cancel`).
- The transfer packet carries `intendedFor: { kind, actor }`; `accept` checks both.
- Claims (Phase 3) still do not move by themselves (no composite transaction). A handoff is admitted only when **no** live claim exists: the sender releases its claim first, then hands off. If anyone claims in between, the handoff is refused, which is safe. So a recipient never inherits a fenced item it cannot touch; it resumes, then claims.

## Claims in the exchange (E3)

- Profile flag `requireClaim: true` for the exchange: `capture` (every kind except `handoff`) and `close` need a live claim held by the caller (the admit hook refuses with "claim this work first"). `open`, `resume` and `handoff` do not: resume is how a recipient takes over, and handoff requires that no claim is live (above).
- Private profiles keep `requireClaim` off: behaviour unchanged.

## Store changes (small, additive)

- `WorkItem.pendingHandoff?` (absent = none). `Delta.kind` adds `handoff_cancel` (declared delta-log capability bump, like `close`). `Delta.targetActor?`.
- `CaptureDeltaInput.targetActor?` for kind `handoff`.
- The admit context gains `actor` and `pendingHandoff` so the fence can decide on settled state under the root lock (same order as Phase 3: replay → recover → re-read → admit → CAS).
- Where the check lives (E4): the recipient rule is **core** (a store with actors enforces it in `resume`/`capture`/`close` directly, since `pendingHandoff` is core state), and the claim requirement stays in the claims fence. A raw store opened on the exchange root still obeys the recipient rule; it does not obey claims (the Phase 3 deployment invariant).

## MCP and CLI

- `work_handoff` gains `to_actor` (required when the profile has actors). New `work_handoff_cancel`. `work_list` / `work_context` show `pending_handoff` and `for_me: true|false`.
- `work_inbox`: pending handoffs addressed to this actor.
- CLI: `trajecta exchange-init <root>` writes the exchange profile (actors, owner, `requireClaim`) and prints the MCP config block each agent adds.

## Decisions for Lam

- **E1 — where the recipient binding lives.** Proposal: in the core work item (`pendingHandoff`), set by the handoff commit and cleared by the resume/cancel commit: one durable commit each, crash-safe by construction. Alternative: a `handoffs` domain journal, which reintroduces the two-commit crash window you flagged for claims.
- **E2 — actor identity.** Proposal: server-stamped from `TRAJECTA_ACTOR`, checked against the profile's actor list; attribution, not authentication (trust model above).
- **E3 — claims required in the exchange** for capture/close (not open/resume/handoff; handoff instead requires no live claim). Proposal: yes via `requireClaim` in the profile; private profiles unchanged.
- **E4 — enforcement split.** Proposal: recipient rule in core (it is core state); claim rules (including "handoff only with no live claim") in the fence.

## Out of scope

Moving AWM/LWM onto TWM (Phase 4); copying work between private and exchange; cryptographic actor identity; hosts other than the Mac mini sharing one root (the root lock is same-host).
