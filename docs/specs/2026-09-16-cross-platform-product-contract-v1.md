# Trajecta Cross-Platform Product Contract v1

**Status:** LOCKED implementation contract  
**Date:** 2026-09-16  
**Scope:** product/runtime/platform boundary  
**Applies to:** core, daemon, CLI, desktop client, adapters, storage, CI, release claims  

This document locks the platform contract before further implementation. It exists to prevent a macOS-first implementation from becoming the accidental product architecture, and to prevent later Linux or Windows support from becoming incompatible ports.

A change to this contract requires an explicit contract revision. Implementation convenience, one platform's API, or an existing alpha assumption is not sufficient reason to silently weaken it.

---

## 1. Product settlement

Trajecta is a cross-platform work-continuity system for AI builders who move work between cloud planning surfaces and local execution agents.

The supported product platforms are:

- **macOS**
- **Linux**
- **Windows**

All three are first-class targets of the same product contract.

Linux is not a server-only afterthought. Windows is not a later compatibility port. macOS is not the semantic reference implementation.

The same work trajectory, transfer semantics, revision behavior, receipts, conflict handling, and security model must survive across all supported platforms.

---

## 2. Core invariant: one semantic system, three platform implementations

Trajecta MUST have one platform-neutral semantic core and one versioned protocol.

Platform-specific code may implement operating-system mechanisms, but MUST NOT redefine product semantics.

The shared core owns:

- work IDs and branch semantics;
- material-delta semantics;
- revision/CAS rules;
- operation idempotency rules;
- contract anchors;
- transfer packet schema;
- receipt levels;
- stale-work rejection;
- routing semantics;
- bounded-context rendering;
- replay semantics;
- migration rules.

The platform layer owns only mechanisms that genuinely vary by OS, including:

- process identity;
- file locking;
- secure file creation;
- symlink/reparse-point defenses;
- filesystem capability detection;
- IPC endpoint creation;
- process lifecycle;
- app autostart/install integration;
- optional local key storage.

**Drift guard:** shared core code MUST NOT encode Darwin, Linux, or Windows behavior directly when that behavior belongs behind a platform capability interface.

---

## 3. Canonical product architecture

The product is composed of five layers.

```text
Desktop app / CLI / host adapter
            │
            ▼
      Trajecta protocol
            │
            ▼
        trajectad
  authoritative local writer
            │
            ▼
    platform-neutral core
            │
            ▼
 durable workspace state + log
```

### 3.1 Core

The core is deterministic and platform-neutral. It MUST be runnable in tests without desktop UI or host integration.

### 3.2 `trajectad`

`trajectad` is the canonical local runtime.

It MUST:

- be the single authoritative writer for a workspace during normal product operation;
- own mutation serialization;
- own workspace lease/epoch state;
- expose the same logical operations on macOS, Linux, and Windows;
- reject stale writes rather than merge them implicitly;
- recover interrupted operations without blind retry;
- emit durable receipts for its own accepted operations;
- expose health/capability state to clients.

The daemon exists specifically so cross-platform correctness does not depend on reproducing one OS's file-locking primitives on another OS.

### 3.3 CLI

The CLI is a thin client of `trajectad` in normal product mode.

It MUST be available on macOS, Linux, and Windows.

A direct-store development mode may exist for tests or recovery, but MUST NOT become the normal product write path and MUST NOT weaken the daemon's single-writer guarantees.

### 3.4 Desktop client

Trajecta MUST provide a desktop product surface for macOS, Linux, and Windows.

The desktop client is a client of `trajectad`; it MUST NOT contain a second independent storage engine.

Minimum cross-platform product capabilities are:

- open/select a workspace;
- inspect the current work item and branch;
- inspect blockers, open loops, next action, and provenance;
- create or inspect a handoff packet;
- accept/reject a resume with visible revision/conflict state;
- inspect receipts and operation history;
- inspect daemon/runtime health;
- expose degraded/unsupported filesystem capability warnings;
- export inspectable state without exposing hidden model data.

UI layout may differ by OS. Product semantics may not.

### 3.5 Host adapters

Adapters connect Trajecta to ChatGPT, Claude, Codex, Claude Code, Cursor, or other hosts.

Adapters MUST use the same versioned Trajecta protocol and receipt model on every OS.

No adapter may infer delivery, read-back, resume, or outcome verification from a weaker receipt.

---

## 4. Transport contract

`trajectad` MUST support a transport-neutral logical API.

The canonical logical operations are:

- `route`
- `open`
- `capture`
- `transfer`
- `accept`
- `resume`
- `handoff`
- `outcome`
- `inspect`
- `health`

Exact naming may evolve only through a versioned protocol revision.

### Local client transport

The implementation may use different local IPC primitives per OS:

- Unix-domain socket or equivalent on macOS/Linux;
- named pipe or equivalent on Windows.

The wire semantics MUST remain identical.

### Host/agent transport

The product MAY expose:

- MCP over stdio for local coding agents;
- MCP or equivalent over authenticated local/remote HTTP where a cloud host requires it.

Transport existence is not evidence of target receipt. Receipt levels remain separate.

---

## 5. State and packet contract

### 5.1 State authority

Current user input and current workspace evidence remain authoritative over any transferred packet.

A packet is candidate context, not final truth.

### 5.2 Packet trust split

A transfer packet MUST distinguish:

**Anchored fields**

- `workId`
- `revision`
- state digest at that revision
- contract-anchor digest/reference
- source/runtime identity needed for receipt verification

**Proposed fields**

- plan
- next action
- open loops
- explanatory summary
- other model-authored continuation context

Proposed fields are untrusted candidate context. They MUST NOT be allowed to impersonate anchored state.

### 5.3 Terminology

Until cryptographic authenticity exists and is verified, product copy MUST NOT call a packet "verified" merely because its digest is internally consistent.

Use precise terms such as:

- revision-checked;
- digest-checked;
- locally signed;
- host-received;
- host-resumed;
- outcome-verified.

---

## 6. Revision, lease, and concurrency contract

Trajecta MUST separate content revision from active-writer ownership.

### Revision

`revision` changes only when semantic work state changes.

### Lease

Writer ownership is represented separately, conceptually as:

```text
lease {
  holder
  epoch
  expiresAt
}
```

Acquiring or renewing a lease MUST NOT by itself advance content revision.

Every mutation MUST be checked against:

- expected content revision; and
- current writer epoch/authority where applicable.

A stale client MUST be rejected with enough information to reconcile. It MUST NOT silently overwrite a newer branch or instruction.

`trajectad` is the normal single-writer authority. Product clients do not each invent their own lock semantics.

### Root write lock (core, 2026-09-28)

Until `trajectad` exists, and underneath it afterwards, the core serialises every store and domain-journal mutation on a root with one cross-process lock (`<root>/.trajecta-write-lock/`, atomic `mkdir`, owner nonce/pid/hostname). CAS is checked after the lock is held, so two writers at the same revision produce one success and one `RevisionConflict`, never a lost write. An ownerless lock is `LockInDoubt` and is never removed automatically; a stale lock is recovered only on the same host with a dead owner pid. See `docs/specs/2026-09-28-core-root-lock-and-close.md`.

### Work claims: the lease in core (2026-09-29)

The lease above is implemented as a **work claim** (`claims` domain journal): holder = surface kind + name + session, epoch, `expiresAt`. Claiming or renewing never changes the work revision. The store's admission hook (`admit`) checks the claim under the root lock after replay, recovery and re-read, before CAS, for capture/resume/close (not open). While a claim is live, only its holder with the exact epoch may mutate; the epoch never resets. Claims are explicit in this phase; moving a claim inside handoff/resume needs a composite crash-safe transaction and is deferred. A claim is granted only after pending store operations are settled. **Deployment invariant:** the claim guarantee holds only when every writer on the root runs a fenced store (the MCP server does); a raw or custom `TrajectaStore` without the admit hook does not obey claims and MUST NOT share a root with claim users. See `docs/specs/2026-09-29-phase3-cases-skills-claims.md`.

---

## 7. Durable storage contract

The logical storage model is cross-platform and replayable.

### 7.1 Delta log

Material work history remains append-oriented and inspectable.

A delta MUST contain enough information for deterministic replay of the fields it changes.

#### Delta-log compatibility (2026-09-28)

Delta kind `close` (terminal `complete` / `abandoned`, bound to a typed `work_close` receipt) was added to the delta log. State schema backward compatibility is preserved (`state.json` stays `trajecta.state/v1`); **historical delta-log readers prior to close support are not forward-compatible** and reject a log that contains a `close` delta. This is a declared delta-log capability bump, not a silent one.

### 7.2 Snapshotting

The product MUST support periodic snapshots so replay cost does not grow without bound.

Rebuild must be possible from:

```text
nearest valid snapshot + subsequent deltas
```

### 7.3 Operation journal

Operation records MUST NOT duplicate full workspace snapshots per operation.

They should contain bounded transaction metadata such as:

- operation ID;
- input digest;
- delta/reference ID;
- before digest;
- after digest;
- reservation/commit status;
- receipt reference.

### 7.4 Idempotency

Byte-equivalent retry of an in-window operation returns the prior result.

Reusing an operation ID with different input fails closed.

Expired idempotency history MUST NOT cause an old operation ID to be silently treated as a brand-new operation.

### 7.5 Durability claim boundary

Trajecta may claim crash-consistent behavior only where tests support that claim.

It MUST NOT claim universal power-loss durability merely because `fsync` was called. Platform/filesystem differences must be documented and surfaced as capability state.

---

## 8. Filesystem and security contract

Security invariants are semantic; implementation primitives are platform-specific.

### 8.1 No primitive-as-contract

`O_EXLOCK`, `O_NOFOLLOW_ANY`, Linux `flock`, Windows sharing flags, or any one OS primitive are implementation details, not the product contract.

### 8.2 Path safety

Before mutating workspace state, the runtime MUST defend against path substitution appropriate to the OS:

- symlinks on macOS/Linux;
- junctions/reparse points on Windows;
- unexpected ownership/permission changes;
- unsupported network/sync filesystem semantics where atomicity cannot be trusted.

If equivalent protection cannot be established, the runtime MUST fail closed or explicitly enter a degraded mode. It MUST NOT silently drop the invariant.

### 8.3 Filesystem capability probe

Runtime startup MUST probe capabilities rather than branching only on `process.platform`.

At minimum the probe should cover:

- atomic replace behavior;
- local vs network/sync filesystem class;
- lock/lease mechanism availability;
- path-link/reparse protections;
- ownership/permission model;
- required process-identity support.

### 8.4 Unsupported/degraded locations

The product MUST distinguish supported local filesystems from locations whose semantics may be unsafe for durable coordination, including network mounts and some host-shared/container/sync folders.

The exact list is implementation evidence, not a marketing assumption. It belongs in a tested capability table.

---

## 9. Platform contract

### 9.1 macOS

macOS is a first-class product target.

The runtime MUST support the same semantic operations, daemon protocol, conflict behavior, receipts, and replay tests as Linux and Windows.

Darwin-only primitives may be used inside the macOS platform adapter, never as shared-core assumptions.

### 9.2 Linux

Linux is a first-class product target for both developer/runtime use and desktop use.

The Linux implementation MUST:

- support native local workspaces;
- work without assuming BSD/macOS file flags;
- work in common developer environments where practical, including containers/remote development, subject to filesystem capability checks;
- support daemon + CLI + desktop client;
- publish explicit degraded/unsupported behavior for WSL mounted Windows paths or other filesystems whose semantics cannot satisfy the contract.

### 9.3 Windows

Windows is a first-class product target.

The Windows implementation MUST:

- support native Windows workspaces without requiring WSL;
- support daemon + CLI + desktop client;
- use Windows-native process/IPC/path mechanisms behind the platform interface;
- defend against junction/reparse-point substitution rather than assuming Unix symlink behavior;
- preserve identical packet, revision, receipt, and replay semantics.

WSL is treated as a Linux runtime when Trajecta runs inside WSL. Native Windows Trajecta remains a separate supported runtime.

---

## 10. Unicode and routing contract

Routing MUST be Unicode-safe and MUST NOT destroy meaningful user language information.

Canonical text normalization is **NFC**, not destructive NFKD stripping.

The routing/tokenization layer MUST:

- preserve accented Vietnamese as canonical tokens;
- allow accent-insensitive auxiliary matching without replacing canonical text;
- preserve meaningful one-character words;
- avoid an ASCII-only token contract;
- have test fixtures for Vietnamese and at least one non-Latin script.

This requirement is platform-independent and must pass identically on macOS, Linux, and Windows.

---

## 11. Cross-platform parity law

The following are required to be semantically identical across macOS, Linux, and Windows:

| Invariant | macOS | Linux | Windows |
|---|---|---|---|
| Work/branch schema | same | same | same |
| Revision/CAS semantics | same | same | same |
| Idempotency semantics | same | same | same |
| Receipt levels | same | same | same |
| Packet schema | same | same | same |
| Anchored/proposed split | same | same | same |
| Delta replay result | same | same | same |
| Stale writer rejection | same | same | same |
| Byte-budget behavior | same | same | same |
| Unicode routing semantics | same | same | same |

Platform-specific mechanisms may differ, but no platform may ship by deleting one of these invariants.

---

## 12. Desktop product parity law

A desktop release is not considered cross-platform merely because it launches.

Before an OS is advertised as supported, its desktop client MUST pass the same user-flow acceptance suite:

1. open a workspace;
2. connect to/discover `trajectad`;
3. route to an exact work item;
4. inspect anchored and proposed context;
5. create a transfer;
6. reject a deliberately stale resume;
7. accept a current resume;
8. record an outcome;
9. restart daemon/app;
10. reconstruct the same current state and receipts.

No platform-only shortcut may bypass those checks.

---

## 13. CI and release contract

Every release branch MUST run a parity matrix covering all supported OS families.

At minimum:

- macOS;
- Ubuntu Linux;
- Windows;
- supported Node/runtime versions;
- concurrency tests;
- crash/interruption recovery tests;
- Unicode routing fixtures;
- replay/digest equivalence fixtures;
- packet tamper/revision conflict fixtures.

Linux x64 and arm64 should both be covered before claiming broad Linux support. macOS Apple Silicon is mandatory. Windows x64 is mandatory for v1 Windows support; additional architectures require their own explicit support declaration.

A release MUST NOT be labeled generally supported if a critical semantic parity test is skipped on one advertised platform.

---

## 14. Distribution contract

The product must be installable by normal users on all three target OS families.

The exact packaging technology is NOT locked by this document. The release contract is:

- one supported install/update path for macOS;
- one supported install/update path for Linux;
- one supported install/update path for Windows;
- versioned CLI/daemon artifacts for developers;
- integrity metadata for distributed artifacts;
- clear compatibility and migration notes.

Packaging technology may change without changing semantic contracts.

---

## 15. Public/private and product-boundary contract

Open core and commercial/product layers must be explicit.

A public repository MUST NOT accidentally contain code or documentation intended to be proprietary solely because the product began as one repository.

Before a flagship public showcase:

- decide and document the public/private boundary;
- remove private/product-only material from the public history as far as practically possible;
- avoid personal filesystem paths or personal contact data in public evidence;
- make README claims match implemented behavior;
- fix repository URLs and quickstart;
- establish real CI rather than static status claims.

Licensing changes are not retroactive assumptions. Previously published code must be treated according to the license under which it was exposed unless qualified legal review establishes otherwise.

---

## 16. Flagship gate

Trajecta may be called a flagship product only after the system demonstrates a real host-to-host continuity flow rather than a same-process simulation.

Minimum flagship evidence:

1. one cloud planning surface creates or consumes a real Trajecta transfer through an adapter;
2. one local agent resumes the exact work through `trajectad`;
3. a stale/competing transfer is rejected or surfaced explicitly;
4. the local side performs work and returns an outcome;
5. the receiving host produces a receipt at the level actually claimed;
6. the flow is reproducible on macOS, Linux, and Windows at the semantic-contract level, even if individual host apps are unavailable on one OS.

No README or landing page may promote a stronger receipt or transport guarantee than the test evidence supports.

---

## 17. Implementation order locked by this contract

This order is deliberate. Later steps must not be used to hide earlier contract failures.

### Phase A — truth and repo hygiene

- public/private boundary;
- licensing/security cleanup;
- truthful README/landing claims;
- correct repository/quickstart;
- cross-platform CI skeleton.

### Phase B — semantic core repair

- NFC/Unicode routing;
- anchored/proposed packet split;
- correct receipt naming;
- delta replay + snapshots;
- bounded operation journal;
- migration tests.

### Phase C — `trajectad`

- single-writer runtime;
- lease/epoch model;
- stale-client reconciliation;
- crash recovery;
- platform capability interface;
- health/capability reporting.

### Phase D — platform parity

- macOS adapter;
- Linux adapter;
- Windows adapter;
- parity fixtures and CI;
- filesystem capability handling.

### Phase E — clients and adapters

- CLI parity;
- desktop client on macOS/Linux/Windows;
- MCP/host adapter;
- real receipt-bearing handoff demo.

### Phase F — distribution and showcase

- installers/artifacts;
- signed/integrity-verifiable releases where applicable;
- public demo;
- only then broaden marketing claims.

---

## 18. Explicit non-goals for v1

To prevent scope drift, this contract does NOT require:

- three separate platform-specific semantic implementations;
- platform-specific packet schemas;
- a Linux-only fork;
- WSL as a prerequisite for Windows;
- automatic transcript ingestion;
- hidden-model-state capture;
- universal support for network or sync filesystems;
- a claim of power-loss-proof storage without platform evidence;
- cloud-host behavior inferred from transport acceptance;
- feature expansion unrelated to continuity, receipts, or cross-platform parity.

---

## 19. Change-control law

Any future implementation proposal that changes one of the following requires a new contract revision:

- supported OS families;
- packet/trust model;
- revision semantics;
- receipt semantics;
- single-writer authority;
- replay/durability model;
- public/private product boundary;
- minimum desktop parity;
- release parity gate.

A platform limitation may justify a different mechanism, not silent semantic weakening.

If an implementation cannot satisfy this contract on an advertised platform, the correct states are:

1. fix the implementation;
2. mark the capability degraded/unsupported; or
3. explicitly revise the contract.

**Never silently drift.**
