# Phase 3: cases, skill evolution, work claims

**Date:** 2026-09-29
**Builds on:** `2026-09-28-work-layers-from-awm.md` (Phase 3 row), `2026-09-29-phase2-learning-loop.md`
**Source studied:** AWM (`cases`, `hypotheses`, `skill-evolution`, `lifecycle` claims); LWM's skill evolution is the same code.
**Status:** proposal. Three decisions (D1–D3) need Lam's settlement before implementation.

## Principle

**An owner receipt gates exactly the transitions that change what other agents are told to do, or that end work.** Everything else is agent-attested with typed evidence, and stays out of policy.

| Transition | Gate |
|---|---|
| close work (Phase 1) | owner receipt `work_close` |
| incident → invariant (Phase 2) | owner receipt `incident_promotion` |
| skill version → active, rollback (this phase) | owner receipt `skill_activation` / `skill_rollback` |
| hypothesis → supported / refuted (this phase) | typed evidence, agent-attested (D1) |
| case → resolved (this phase) | a supported hypothesis in the case (D1) |

Same receipts ledger, new typed purposes; a receipt of one purpose never authorises another. No MCP tool issues receipts.

## A. Debug cases and hypotheses

Two domain journals: `cases.jsonl` → `case-index.json`, `hypotheses.jsonl` (projected into the same index by `caseId`). Every event has an operation id (reserve/commit replay, altered replay refused) and evidence refs.

**Case events** (`case:<slug>` ids)

- `open`: title, workIds (≥1, must exist), optional signatures. Opening an existing id is refused.
- `member_added` / `member_removed`: one incidentId. It must exist; you can't add an incident twice or remove a non-member.
- `status`, with an explicit transition table (AWM accepts any status; this tightens it):
  - open → resolved | challenged | deprioritized
  - challenged → resolved | reopened | deprioritized
  - resolved → reopened | challenged
  - reopened → resolved | challenged | deprioritized
  - deprioritized → reopened

**Hypotheses**

- Fields: `hypothesis:<slug>` id, caseId, statement, optional signature, supportingRefs, disconfirmingRefs, optional discriminatingCheck, author (surface).
- Identity (case, statement, signature) is fixed across updates.
- Status: `hypothesis` → `supported` | `refuted`. A verdict is final; a new idea is a new hypothesis.
- A `hypothesis` carries no verification. A verdict requires `verificationRef` (D1).

**Context**

- normal: `linked_cases` (last 5 cases touching the work: id, title, status, incident ids).
- debug: adds each case's hypotheses without refs.
- audit: adds raw case events and hypotheses.
- Same fixed-point budget as today.

## B. Skill evolution

One domain journal `skills.jsonl` → `skill-index.json`, with typed events:

- **pattern**: a revision chain with `previousRevisionId` (null only for the first revision) and evidence refs.
- **version**: immutable.
  - Fields: skillId, versionId, parentVersionId (null only for a skill's first version), cluster, content, contentDigest (sha256), motivatingRefs (≥1), proposer, targetSurfaces.
  - A duplicate versionId is refused.
- **validation**: decisionId, skillId, versionId, outcome (accepted | rejected | blocked | expired), baseline and candidate scores in [0,1], evidenceRefs, reason, validator. `accepted` requires candidate > baseline strictly.
- **activate**: owner receipt `trajecta.owner-approval-receipt/v1`, purpose `skill_activation`.
  - The receipt binds skillId, versionId, expectedParentVersionId, decisionId and contentDigest.
  - The CLI `trajecta approve-skill <skill> <version> <decision>` refuses unless the decision is an accepted validation of that exact version, and the version's parent equals the current active pointer (or both are null).
  - Activation is CAS on the pointer, so only a direct child of the active version can activate. There is one active version per skill.
- **rollback**: owner receipt purpose `skill_rollback`, binding skillId, from, to and a reason digest. `from` must be the current pointer; `to` must have been active before.
- Both activate and rollback follow the three-stage promotion shape: locked replay → pure validation → unlocked resolve → locked recheck + append.

**Agents see:**

- `work_context` normal gets `active_skills` for the work's cluster: id, version, title, contentDigest. No content.
- `work_skill_get(skill_id)` returns the active content; with `mode: audit` it adds the history.
- **Candidates never reach normal context.**

## C. Work claims (exclusive execution across surfaces)

This is not AWM's controller-authority/successor machinery, which is local-execution-specific. It is a smaller fence on top of relay.

- Domain journal `claims.jsonl` → `claim-index.json`, holding one live claim per work item: `{claimId, workId, holder: surface + session, epoch, acquiredAt, expiresAt}`.
- `work_claim(work_id, lease_minutes?)` → claim + epoch.
  - Refused while another holder's claim is live.
  - `lease_minutes` defaults to 120; the maximum is set by the profile.
- `work_release(work_id, claim_epoch)`.
- A lease expires on its own; there is no owner step, because a dead cloud session must not wedge the work.
- `work_handoff` releases the sender's claim. `work_resume`, when it accepts a packet, acquires a claim for the recipient in the same locked mutation (epoch + 1).
- Fence: while a live claim exists, `capture`, `resume` and `close` from anyone except the holder session are refused (`ClaimConflict`). The holder must pass the current `claim_epoch`; a stale epoch is refused. With no live claim, behaviour is unchanged, so this is opt-in per work item.

## Decisions for Lam

**D1. Hypothesis verdict verification.** Proposal: agent-attested.

- `verificationRef` must be a typed ref (`test:` `commit:` `tool:` `artifact:` `audit:`). It must appear in supportingRefs (supported) or disconfirmingRefs (refuted), and is stored as `attestation: "agent"`.
- Case `resolved` requires ≥1 supported hypothesis in that case.
- AWM instead requires a verification *receipt* bound to the case's task. In TWM, receipts are owner-only, which would put the owner in every debugging step.
- Alternative: owner receipt purpose `hypothesis_verdict`.

**D2. Validator independence.** Proposal: an `accepted` validation must come from a different surface session than the version's proposer. AWM doesn't enforce this; one accepted validation is enough there.

**D3. Where the claim fence is enforced.** Proposal: a small core hook.

- `TrajectaStore` options get `admit?(ctx: {workId, surface, kind, claimEpoch?}) => void`, called inside the root lock after replay, before CAS, in open/capture/resume/close.
- The claims layer supplies it and reads its projection under the held lock.
- Alternative: no core change, with enforcement only in `WorkServer`. That is racy between the check and the mutation, so it is not proposed.

Lam asked earlier to stop polishing core; this is one hook, no behaviour change when unset.

## Import

`import-awm` brings cases and hypotheses (verdicts are kept as history with provenance `source:awm:<id>`, attestation `imported`). It brings skill patterns, versions and validations, but **not active pointers**: those are listed in `skillsPendingReactivation` for owner re-approval, like invariants in Phase 2. No claims are imported (they are live state).

## MCP (0.5.0) and CLI

- **New MCP tools:** `work_case_open`, `work_case_event`, `work_hypothesis`, `work_case_get`, `work_skill_pattern`, `work_skill_propose`, `work_skill_validate`, `work_skill_activate`, `work_skill_rollback`, `work_skill_get`, `work_claim`, `work_release`.
- **New CLI commands:** `approve-skill`, `approve-rollback`.
