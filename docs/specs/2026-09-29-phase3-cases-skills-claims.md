# Phase 3: cases, skill evolution, work claims

**Date:** 2026-09-29
**Builds on:** `2026-09-28-work-layers-from-awm.md` (Phase 3 row), `2026-09-29-phase2-learning-loop.md`
**Source studied:** AWM (`cases`, `hypotheses`, `skill-evolution`, `lifecycle` claims); LWM's skill evolution is the same code.
**Status:** settled by Lam (D1–D3, 2026-09-29) and implemented. The settlement is recorded at the end; the sections below follow it.

## Principle

**An owner receipt gates exactly the transitions that change what other agents are told to do, or that end work.** Everything else is agent-attested with typed evidence, and stays out of policy.

| Transition | Gate |
|---|---|
| close work (Phase 1) | owner receipt `work_close` |
| incident → invariant (Phase 2) | owner receipt `incident_promotion` |
| skill version → active, rollback (this phase) | owner receipt `skill_activation` / `skill_rollback` |
| hypothesis → supported / refuted (this phase) | typed evidence, agent-attested (D1) |
| case → resolved (this phase) | named supported hypotheses of the case, at least one attested here (D1) |

Same receipts ledger, new typed purposes; a receipt of one purpose never authorises another. No MCP tool issues receipts.

## A. Debug cases and hypotheses

One domain journal, `cases.jsonl` → `case-index.json`, holds case events and hypothesis events, so a resolution and the hypotheses it rests on are decided by one projection. Every event has an operation id (reserve/commit replay, altered replay refused). Case events carry evidence refs. Ids accept AWM's form: `case:<id>`, `hypothesis:<id>`.

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
- A `hypothesis` carries no verification. A verdict requires `verificationRef`: a `test:` `commit:` `tool:` `artifact:` or `audit:` ref that appears in supportingRefs (supported) or disconfirmingRefs (refuted). It is stored with `attestation: "agent"`.
- The author is the surface the server runs as; a caller cannot name it.
- `resolved` must name `resolutionHypothesisIds`: supported hypotheses of this case, **at least one attested in this store**. Imported verdicts (`attestation: "imported"`) are history only, so a reopened imported case needs a local supported hypothesis to resolve again.

**Context**

- normal: `linked_cases` (last 5 cases touching the work: id, title, status, incident ids).
- debug: adds each case's hypotheses without refs.
- audit: adds raw case events and hypotheses.
- Same fixed-point budget as today.

## B. Skill evolution

One domain journal `skills.jsonl` → `skill-index.json`, with typed events. Ids accept AWM's form (`skill:…`, `skill-version:…`).

- **pattern**: a revision chain with `previousRevisionId` (null only for the first revision) and evidence refs.
- **version**: immutable.
  - Fields: skillId, versionId, parentVersionId (null only for a skill's first version), cluster, content, contentDigest (sha256), motivatingRefs (≥1), proposer, targetSurfaces.
  - A duplicate versionId is refused.
- **validation**: decisionId (server-generated), skillId, versionId, outcome (accepted | rejected | blocked | expired), baseline and candidate scores in [0,1], evidenceRefs, reason, validator. `accepted` requires candidate > baseline strictly **and a validator session different from the proposer session** (D2). Proposer and validator are stamped by the server. Only an accepted, agent-attested, independent validation is `eligible` to back an activation; rejected/blocked/expired need no independence.
- **activate**: owner receipt `trajecta.owner-approval-receipt/v1`, purpose `skill_activation`.
  - The receipt binds skillId, versionId, expectedParentVersionId, **expectedPointerEpoch**, decisionId and contentDigest.
  - Each skill has a `pointerEpoch`: 0 until the first activation, +1 on every activation and rollback, never reset (imported skills have no active pointer, so they start at 0). Activation and rollback receipts bind the epoch at issue time and the locked re-check requires it exactly, so after any pointer move an older receipt is dead. Without it, v1 → v2 → rollback v1 would revive the old v1→v2 receipt (ABA) and let two old receipts toggle policy forever.
  - The CLI `trajecta approve-skill <skill> <version> <decision>` refuses unless the decision is an eligible validation of that exact version, and the version's parent equals the current active pointer (or both are null).
  - Activation is CAS on the pointer, so only a direct child of the active version can activate. There is one active version per skill.
- **rollback**: owner receipt purpose `skill_rollback`, binding skillId, from, to, expectedPointerEpoch and a reason digest. `from` must be the current pointer; `to` must have been active before.
- Both activate and rollback follow the three-stage promotion shape: locked replay → pure validation → unlocked resolve → locked recheck + append.

**Agents see:**

- `work_context` normal gets `active_skills` for the work's cluster: skill id, active version id, content digest and pointer epoch. No content, no title (versions have none; `work_skill_get` returns the content).
- `work_skill_get(skill_id)` returns the active content; with `mode: audit` it adds the history.
- **Candidates never reach normal context.**

## C. Work claims (exclusive execution across surfaces)

As settled (D3): the fence is in core; claims are **explicit**. Handoff and resume do not move a claim in this phase, because releasing and acquiring inside a work mutation would need one crash-safe transaction across the store and the claims journal (the root lock prevents races, not a crash between two commits). That is deferred.

This is not AWM's controller-authority/successor machinery, which is local-execution-specific. It is a smaller fence on top of relay.

- Domain journal `claims.jsonl` → `claim-index.json`, holding one live claim per work item: `{claimId, workId, holder: surface + session, epoch, acquiredAt, expiresAt}`.
- `work_claim(work_id, lease_minutes?)` → claim + epoch.
  - Refused while another holder's claim is live.
  - `lease_minutes` defaults to 120; the maximum is 720.
- `work_release(work_id, claim_epoch)`.
- A lease expires on its own; there is no owner step, because a dead cloud session must not wedge the work.
- Claiming again from the holder session renews the lease (same epoch). The epoch rises on every acquisition and never resets across release, expiry or reacquire.
- `work_release` checks holder session and exact epoch.
- Fence: while a live claim exists, `capture` (and so handoff), `resume` and `close` from anyone except the holder (surface kind, name, session) are refused (`ClaimConflict`). The holder must pass the exact `claim_epoch`. With no live claim, passing an epoch is refused (the caller's claim was released or expired); passing none leaves behaviour unchanged.
- Handoff protocol for now: the sender releases, the receiver claims, then resumes with its epoch.
- `work_claim` is refused on a store without the fence, so a claim never pretends to protect anything.
- A claim is granted only on settled state: under the root lock, `claim` first finishes any reserved-but-uncommitted store operation through the core's held-only boundary (`store.getWorkSettledHeld`), then decides. A close that crashed after its reservation is completed first and the claim is refused ("Closed work cannot be claimed"); no claim is left on terminal work. The WAL logic stays in the store.
- **Deployment invariant:** the guarantee holds only if every writer on a root runs a fenced store (`admit: claimFence(root)`). The MCP server (`runStdio`) does. A raw or custom `TrajectaStore` without the hook does not obey claims.

## Store hook (D3)

`TrajectaStore` options take `admit?(ctx: {workId, surface, kind: "capture" | "resume" | "close", claimEpoch?})`. It is not called for `open` (there is no work yet). Under the root lock the order is: replay → recover pending → re-read state → **admit** → CAS → mutate/commit. `admit` is a pure check: it reads the claims projection with `readHeld` and never writes a claim. `close` resolves its receipt outside the lock, so it admits twice: a preflight in stage 1 (a refused caller never reaches the verifier) and again in stage 3 before CAS (the claim can change while the verifier runs). The MCP server wires `claimFence(root)`; with no hook set, behaviour is unchanged.

## Settlement (Lam, 2026-09-29)

- **D1 — yes, agent-attested verdicts, no `hypothesis_verdict` receipt.** Typed ref in the matching list; verdict final; author/attestation from the trusted server surface; `resolved` records its explicit basis (`resolutionHypothesisIds`); imported verdicts are history, and a reopened imported case needs local agent-attested support to resolve.
- **D2 — yes, a different session for an accepted validation.** Different session is the minimum while there is no stable actor identity; it can be strengthened to a different actor later. Import does not bypass it: an imported accepted validation stays history, and activation or reactivation needs a new eligible validation.
- **D3 — yes, core admit fence; WorkServer-only is rejected (racy).** Not called for open; exact order above; epoch monotonic; release checks holder and epoch; admit is pure; close admits twice. Automatic claim transfer on handoff/resume is deferred until a composite crash-safe transaction is designed.
- Skills: approved as proposed.

## Import

`import-awm` / `import-lwm` read `case-events.jsonl`, `case-hypotheses.jsonl`, `skill-patterns.jsonl`, `skill-versions.jsonl`, `skill-validations.jsonl` and `skill-active-pointers.json`. Everything comes across as history with attestation `imported` and provenance `source:<awm|lwm>:<id>`: cases on live work (a case whose tasks were all archived is skipped and reported), their incident members (mapped to the imported incidents), statuses (the transition table applies to local changes only), hypotheses and verdicts, pattern revisions (re-chained), versions and validations (never eligible). **Active pointers are not activated**: they are listed in `investigation.skillsPendingReactivation`. No claims are imported (they are live state). Re-import replays.

## MCP (0.5.0) and CLI

- `work_capture`, `work_handoff`, `work_resume` and `work_close` accept `claim_epoch`.
- **New MCP tools:** `work_case_open`, `work_case_event`, `work_hypothesis`, `work_case_get`, `work_skill_pattern`, `work_skill_propose`, `work_skill_validate`, `work_skill_activate`, `work_skill_rollback`, `work_skill_get`, `work_claim`, `work_release`.
- **New CLI commands:** `approve-skill <skill> <version> <decision>` (refuses unless the decision is an eligible validation of that version and the version is a direct child of the active one) and `approve-rollback <skill> <to-version> --reason "…"` (refuses a target that was never active). No MCP tool issues a receipt.
