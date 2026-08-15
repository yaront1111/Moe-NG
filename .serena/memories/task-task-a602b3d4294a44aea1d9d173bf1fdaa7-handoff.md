# Handoff: StoredEvent domainSchemaVersion (Task B1) — DELIVERED, in REVIEW

Supersedes the earlier PLANNING-phase note of the same name.

## Review by PATH, not by commit — deliverable spans two commits
- `273f417` (mine, explicit pathspec, 5 paths): read-page-queries, event-read-decode,
  decision-ledger-canonical, + the 2 forced key-set test edits.
- `baa8012` (foreign, `task-556d87c3` Policy approval core) SWEPT 5 of my in-flight files:
  store-contracts, store-internals, store-input-commit, event-ledger-append,
  store-domain-schema-version.test.ts (222 lines). Content byte-identical to what passed the
  gate (`git diff baa8012 -- <paths>` empty). NOT reverted — live foreign work.
  See `mem:gotcha-shared-tree-broad-add-sweep`.

## What shipped
- `DOMAIN_EVENT_SCHEMA_VERSION = 'moe-domain-schema/0'` in store-contracts, matching Task A's
  DDL default. NOT exported from index.ts — index uses an EXPLICIT named-export list (not
  `export *`), so it stays in-package. **The upcaster task must add it to index.ts** if
  external callers need to name the default.
- `EventDraft.domainSchemaVersion?` OPTIONAL (defaults on write — this is why no existing
  caller/test broke); `StoredEvent.domainSchemaVersion` REQUIRED; `SnapshotEventDraft` required.
- Validation = `requireIdentifier` (charset-agnostic: non-empty, <=512 UTF-8 bytes,
  well-formed, no NUL — a `/` is fine). Values are OPAQUE by design; upcasters dispatch on
  whatever the producer stamped.
- Read side: column in `STORED_EVENT_SELECT_COLUMNS` AND `EVENT_DECODED_BYTES_SQL`;
  `mapStoredEvent` uses `requireRowString`, **deliberately NOT `requireStoredVersion`** —
  pinning to one constant would make every future version read as STORE_CORRUPT.

## Correction to the plan's stated mechanism (matters for the upcaster task)
The plan claimed `EffectEventDraft`'s `Omit<..., 'domainSchemaVersion'>` prevents a
write/replay DIGEST divergence. **Wrong mechanism.** `identifyCommandEffects`
(store-digests.ts:190-221) hashes an EXPLICIT FIELD LIST, never key enumeration — a stray
runtime property (e.g. from the append-site spread) can never change digest bytes.
The Omit is load-bearing at the TYPE level: without it,
`DecodedReceiptEventBody` (event-read-decode.ts:55-58, derived from EffectEventDraft) and the
replay literal (event-read-materialization.ts:156-162) both fail to compile.
Corollary for future work: to change effect-digest content you must bump
`COMMAND_EFFECT_IDENTITY_VERSION`, not just add a field.

## Facts worth reusing
- Only TWO `SnapshotEventDraft` literal producers exist repo-wide: store-input-commit.ts:55
  and decision-ledger-canonical.ts (rejection-audit literal, BYPASSES snapshotCommitInput —
  the easy-to-miss write site).
- `sqlite-event-store.ts` is a pure pass-through facade over private `#core`; B1 needed no
  edit there.
- Key-set pins on StoredEvent (break on any new key): event-read-model-contract.test.ts
  `expectedEvent()` (toStrictEqual x5) and sqlite-event-store-core.test.ts (toEqual, 2
  literals). No third file. `event-page-byte-budget.test.ts` computes its budget dynamically
  from EVENT_DECODED_BYTES_SQL, so it absorbed +20 bytes/row untouched.
- `proposedDecision()` in command-decision-test-helpers is hard-scoped to projectId
  `project-1`; a store opened with another projectId dies on PROJECT_SCOPE_MISMATCH before
  your assertion runs.
- Baseline 20 files/124 tests -> 21/137 after B1 -> 22/143 once sibling B2's seam landed.

## Sibling task-bfc39542 (seam) landed during my final step
It owns `commitWithApply`, `PROJECTION_APPLY_FAILED` (added to the union), and
store-projection-seam.test.ts. Disjoint from B1 as planned. DoD items 2-3 of the original
task belong to it, not to this one.
