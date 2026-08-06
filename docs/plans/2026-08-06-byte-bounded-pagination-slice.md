# Byte-Bounded Store Pagination Implementation Plan

**Goal:** Prevent cursor reads from materializing an unbounded total of event, outbox, or decision bytes while preserving ordered, resumable pagination.

**Architecture:** Each cursor read first selects only ordered cursor/byte-count metadata, chooses the largest prefix within both the row and fixed 64 MiB production ceiling, and only then fetches or validates the selected records. Callers may request a smaller test/client budget, but never raise the fixed ceiling. This is a provisional, domain-neutral store hardening slice; it adds no command or lifecycle authority.

### Task 1: Specify the byte-prefix contract

- [x] Add focused tests for exact-boundary selection, one-byte deferral, first-record refusal under a caller-lowered budget, corrupt over-ceiling records, and immutable cursor order.
- [x] Add integration tests for aggregate events, global events, pending outbox, and command decisions, including resume without skips or duplicates.
- [x] Prove an excluded later record is not decoded during the earlier page.

### Task 2: Implement metadata-first pagination

- [x] Add a small shared budget module and runtime bridge.
- [x] Account for BLOB bytes and UTF-8 text bytes using SQLite `length(CAST(... AS BLOB))`.
- [x] Include a decision's result plus every receipt/event/outbox field decoded during decision verification.
- [x] Fetch only the selected prefix and fail closed if rows disappear, reorder, exceed the valid single-record ceiling, or cannot make progress.

### Task 3: Verify and review

- [x] Document the external-read boundary and fixed ceiling.
- [x] Run store/foundation/root tests, strict typecheck, raw Node smoke, `git diff --check`, and file-size audit.
- [x] Obtain an independent hostile review and resolve every BLOCKER/MAJOR before committing explicit paths.
