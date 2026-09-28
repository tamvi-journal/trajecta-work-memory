# Core: root write lock and verified close

**Date:** 2026-09-28
**Status:** plan approved by Lam (Aux ↔ Lam discussion, relayed live through Ty's ChatGPT app)
**Sequence:** merge #4 → merge #5 → this core PR → Phase 2 (learning loop, owner receipts) → exchange profile with exact-recipient handoff

## 1. Root write lock

Two MCP servers pointing at one root (the Aux ↔ Lam exchange) can both read revision N, both pass CAS, and the last `writeAtomic(state.json)` wins. CAS alone is not enough; mutations must be serialised across processes at the root.

- One lock per root: directory `.trajecta-write-lock/`, created with atomic `mkdir` (cross-platform; no `flock`).
- `owner.json` inside: nonce, pid, hostname, acquiredAt. Release only when the nonce matches.
- Bounded retry, then `LockTimeout`.
- **Ownerless lock** (directory present, `owner.json` missing or malformed — e.g. crash between mkdir and owner write) = `LockInDoubt`. Never deleted on timeout, never treated as a normal stale lock. Automatic recovery for this case needs its own protocol later; this phase fails closed.
- **Stale recovery** only when same hostname AND the owner pid is dead: rename the canonical lock to a quarantine name containing the recoverer's nonce, and delete only a quarantine this process renamed itself. Different hostname → no automatic recovery; report the owner.
- **One boundary, no nesting:** `withRootWriteLock(root, mutation)`. After acquiring: replay → recover → re-read state/projection → CAS → mutate → commit. Internal helpers never acquire again; a nested acquire on the same root is rejected deterministically (no deadlock).
- The lock covers every `TrajectaStore` and `DomainJournal` mutation, including recovery/reconcile.
- Plain reads of `state.json` / projections stay lock-free (atomic replace). Anything comparing journal ↔ projection (verify, rebuild, audit) takes the lock or uses explicit snapshot semantics.

## 2. `store.close`

Close is a core lifecycle transition, like open/capture/resume. It does not depend on Phase 2 governance.

```
store.close({ operationId, workId, expectedRevision, status, summary, verificationRef, provenance })
status: "complete" | "abandoned"
```

- Receipt purpose `work_close`, bound to: exact workId, expectedRevision, terminal status, digest of the close intent (summary, provenance, status), authority/evidence class, outcome, issuedAt (and expiresAt if it has a lifetime).
- `complete` = evidence-backed verification. `abandoned` = explicit authorised abandonment, never presented as a verified success.
- Same resolver machinery as incident promotion, different typed semantics: a `work_close` receipt cannot promote an invariant and an `incident_promotion` receipt cannot close work.
- Terminal consistency: after close `nextAction = null`; `complete` with unresolved open loops **fails** (caller resolves them explicitly; never silently cleared); `abandoned` may keep open loops as a record of what was dropped; terminal work accepts no further capture/resume.

## 3. Compatibility

`state.json` stays `trajecta.state/v1`, so state-only readers keep working. Delta-log readers from before close support whitelist delta kinds and will reject a log containing `close`. The contract says so explicitly:

> State schema backward compatibility is preserved; historical delta-log readers prior to close support are not forward-compatible.

A store-format / min-reader marker may be added; `state.json` is not bumped for this.

## 4. Importer after this PR

Replay the source trajectory → if the source terminal record carries enough typed evidence, `store.close` → otherwise `archived-work` fallback. Never fabricate a receipt on import.

## 5. Tests

Real child processes, all three OS:

1. same-revision concurrent capture → exactly one passes CAS, the other gets `RevisionConflict` (never last-writer-wins)
2. concurrent writes to different work items
3. DomainJournal vs DomainJournal
4. crash while holding the lock
5. stale-lock recovery (same host, dead pid)
6. crash after mkdir before owner.json → `LockInDoubt`, lock not removed
7. nested acquire on the same root → rejected deterministically, no deadlock
8. close: complete with open loops fails; abandoned keeps loops; terminal rejects capture/resume; receipt purpose mismatch rejected
