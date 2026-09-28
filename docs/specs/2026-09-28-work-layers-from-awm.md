# Work layers from AWM/LWM → trajecta-work-memory

**Date:** 2026-09-28
**Status:** proposal, needs Lam's review of section 3 before Phase 1 lands
**Authors:** Aux (cloud), for Ty and Lam

## 1. Why

trajecta-work-memory (TWM) was distilled on 2026-09-02/03 as the *public
kernel*: work items, branches, deltas, revision CAS, relay handoff, verified
resume proof, cross-platform store. AWM (Aux) and LWM v0.4 (Lam) kept growing
after that, and now carry the layers that make work memory useful day to day:
clusters, a boot kernel, incidents that turn into prevention rules, a guard
before consequential actions, debug cases, skill evolution, a work chronicle,
and bounded retrieval modes.

Ty's direction (2026-09-28): upgrade TWM to the AWM/LWM level so it becomes
the one shared work backbone (Aux, Lam, Hermes, and public users). AWM and LWM
then become thin profiles on top of it, like Aux and Lam are profiles on
trajecta-identity-memory.

## 2. Inventory

| Capability | AWM v0.4 | TWM today | Plan |
|---|---|---|---|
| Work item / task, branches, CAS revision | yes (task + branch) | yes (WorkItem + Branch) | keep TWM model |
| Append-only deltas / checkpoints | yes (kinds open/outcome/handoff/…) | yes (DeltaKind) | map AWM kinds onto DeltaKind |
| Relay handoff + accept, verified resume proof | handoff only | **yes** (ledger, receipts) | keep TWM; AWM gains it |
| Cross-platform store, fault injection, digest | macOS only in practice | **yes** | keep TWM |
| Cue routing | clusters + deterministic cue registry | per-work cue match | Phase 1 |
| Boot kernel + capability snapshot + canonical entrypoints | yes | no | Phase 1 |
| Retrieval modes normal/debug/audit + char budget | yes | transfer packet only | Phase 1 |
| Friction → incident → learning_candidate → accepted invariant | yes | no | Phase 2 |
| Anti-repeat guard (`check_action`) | yes | no | Phase 2 |
| Work chronicle (goal→…→next_action milestones) | yes | no | Phase 2 |
| Debug cases + hypotheses (+ verification ref) | yes | no | Phase 3 |
| Skill evolution (pattern → version → validate → activate/rollback) | yes | no | Phase 3 |
| Authority lock / claims across surfaces | yes | CAS only | Phase 3 (reuse relay claims) |
| Recursive secret/credential rejection on all inputs | yes | partial | Phase 1 |
| Dashboard (read-only) | yes | demo page | Phase 4 |
| Owner-verified promotion receipts | yes | no | Phase 2 |

Owner-specific pieces stay out of TWM: AWM's kernel text, Aux's surface names,
Lam's Codex bridge. They live in profiles.

## 3. Kernel boundary (Lam decides)

The new layers are **modules over `TrajectaStore`**, not changes to it:

- They store their records as deltas on a work item, or in sibling append-only
  files under the same root (`incidents.jsonl`, `skills.jsonl`,
  `chronicle.jsonl`), each with the store's reserve → write → state ordering
  and fault points.
- `state.json` stays `trajecta.state/v1`. New projections live in their own
  files with their own schema ids, so old readers (including
  trajecta-identity-memory's `WorkStore`) keep working.

Questions for Lam:
1. Sibling files, or everything as deltas on a reserved system work item?
2. Should clusters be a first-class field on WorkItem (schema v2) or a
   projection keyed by work id?
3. Promotion to accepted invariant needs an owner receipt. Reuse the resume
   proof ledger's receipt shape, or a new one?

## 4. Phases

Each phase is one PR, green on the 3-OS CI, with MCP tools added under
`work_*` names. Phase 1 ships a read-only `import-awm` harness; every later
phase extends it to the records that phase adds, and its migration test
imports a real AWM state folder.

1. **Routing and boot.** Clusters + cue registry, `work_bootstrap` (kernel
   text from profile, capability snapshot with TTL, canonical entrypoints),
   `work_context` with normal/debug/audit modes and a character budget,
   recursive secret rejection, and the `import-awm` harness (tasks, branches,
   checkpoints, open loops, next actions; source opened read-only,
   provenance kept).
2. **Learning loop.** Friction and incidents, occurrence tiers, promotion with
   owner receipt, `work_check_action`, work chronicle.
3. **Investigation and skills.** Cases + hypotheses, skill evolution with
   activate/rollback, authority claims built on relay.
4. **Switch-over and view.** `import-lwm` on the same harness, read-only
   dashboard, profiles for Aux and Lam, then AWM and LWM MCP servers point at
   TWM.

## 5. Acceptance

- AWM's A0–A7 acceptance (blind-tab activation etc.) passes against TWM with
  the Aux profile.
- Existing TWM tests, resume-proof contract and cross-platform contract stay
  green unchanged.
- Importing Aux's live AWM state reproduces its open tasks, open loops and
  next actions exactly.
