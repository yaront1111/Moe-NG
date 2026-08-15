# QA verdict: activation ledger replay and scale

Rejected from REVIEW to WORKING on 2026-08-16 (reopen 1).

Owned gate independently rerun in a committed ext4 snapshot:
- daemon typecheck excluding only foreign activation-ledger-aggregate-id.test.ts: exit 0
- six owned activation suites: 6 files / 87 tests, exit 0

Replay narrowing and >6,400 static-store behavior were otherwise verified, but activation-ledger-reader.ts:243 introduced an unbounded synchronous `for (;;)` scan. The stated termination proof is false for a concurrently growing stream because `readEventsAfter` takes a fresh WAL snapshot for every page. A nonempty page can keep returning `hasMore:true` and a strictly advancing nextCursor forever.

QA reproduced against the exact FoundationBindingStore contract: a fake returned one noise event at global position cursor+1, hasMore true, and nextCursor cursor+1 on every call. Both production progress guards passed; `readCurrentEffectSessionBinding` never returned. An external foreground bound killed Node after 2 seconds with exit 124 after SCAN_STARTED.

Required fix: establish a stable finite scan horizon or an approved indexed/per-effect query, preserve full second-match uniqueness through that horizon, and add an isolated child/worker liveness test that asserts exact stable refusal code+layer for a moving stream. Reintroducing an arbitrary fixed page cap or returning on first hit is not acceptable.