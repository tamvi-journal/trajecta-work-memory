# Phase 2: learning loop

**Date:** 2026-09-29
**Builds on:** `2026-09-28-work-layers-from-awm.md` (Phase 2) and `2026-09-28-core-root-lock-and-close.md`
**Review focus Lam asked for:** incident occurrence/promotion semantics; one receipt ledger, purpose-separated; `check_action` applies only accepted invariants.

## Journals (one domain each, shared operation ledger, root lock)

| Domain | Journal | Projection |
|---|---|---|
| incidents | `incidents.jsonl` | `incident-index.json` |
| friction | `friction.jsonl` | `friction-index.json` |
| chronicle | `chronicle.jsonl` | `chronicle-index.json` |
| invariants | `invariants.jsonl` | `invariant-index.json` |
| receipts | `receipts.jsonl` | `receipt-index.json` |

## Incident tiers

Group = (cluster, kind, violated invariant). Tier = number of **distinct evidence sets** in the group at record time: 1 raw, 2 repeated, 3+ learning_candidate. Recording the same evidence again adds an occurrence, never a tier. Every incident needs at least one evidence reference.

## Promotion

`promoteIncident` = locked replay → pure validation → **unlocked** `resolveReceipt(approvalRef)` → locked replay, incident is a `learning_candidate`, not yet promoted, receipt check, append invariant.

Receipt `trajecta.owner-approval-receipt/v1`: purpose `incident_promotion`, exact `incidentId`, `invariantDigest` over incident id + cluster + prevention rule + violated invariant, `authority: "owner"`, `outcome: "approved"`, issuedAt, optional expiresAt. One promotion per incident. No autonomous promotion.

## Receipts: one ledger, typed purposes

All receipts live in the `receipts` domain journal on the shared `domain-operations.jsonl` ledger. `work_close` receipts cannot promote; `incident_promotion` receipts cannot close work (tested both ways). Receipts are issued by the owner with the CLI (`trajecta approve-promotion`, `trajecta approve-close`); **no MCP tool can issue one**. Threat-model note: anyone with a shell on the owner's machine can run the CLI; MCP agents cannot.

## check_action

Returns `blockers` from the profile's **opt-in** guards (`observable-no-headless`, `identity-proof-before-mutation`, `reanchor-after-repeats`; none on by default) and `accepted_invariants` for the cluster for the agent to apply. Candidates and raw incidents never appear. It does not run the action.

## Context

`work_context`: `prevention_rules` (accepted invariants of the work's cluster) in every mode; `incident_summaries` in debug; raw `incidents` and `chronicle` in audit. Budget rules unchanged.

## Import

`import-awm` / `import-lwm` now bring incidents, friction and chronicle (tiers recomputed, provenance `source:<awm|lwm>:<id>`). Source **invariants are not activated**: they are listed in `learning.invariantsPendingReapproval` with the matching imported incident, for the owner to re-approve. Chronicle of tasks that were archived (closed in source) is skipped and reported. Friction imported by a release before friction kept provenance is replayed as recorded (the journal is append-only) and listed in `learning.frictionWithoutProvenance`, never skipped or duplicated.

## MCP (0.4.0)

`work_record_incident`, `work_record_friction`, `work_record_milestone`, `work_promote_incident`, `work_check_action`, `work_close`.

## CLI

The CLI now uses the same store location as the MCP server (`TRAJECTA_HOME`, else the platform data folder), so owner approvals land where agents read them.
