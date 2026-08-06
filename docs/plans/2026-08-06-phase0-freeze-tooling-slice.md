# Phase 0 Freeze Tooling Slice

**Goal:** Make Phase 0 evidence capture executable against the real filesystem and evaluate whether the six-document evidence set, review claim, pinned design and benchmark bytes, target root, and authorization claim are internally consistent without manufacturing freeze authority.

**Boundary:** This slice creates contracts and verification tooling only. It must not create `docs/evidence/phase-0/manifest.json`, `freeze-decision.json`, an authorization record, or a readiness claim while the independent Moe review is absent.

## Task 1: Specify the real capture adapter

- [x] Add focused tests using temporary Git repositories and evidence stores.
- [x] Require exact repository roots, canonical relative paths, stable regular-file reads, immutable commit lookup, raw porcelain-v2 status bytes, and collision-safe content-addressed writes.
- [x] Reject symlink/reparse escapes, invalid object paths, wrong roots, Git failures, and unstable files.

## Task 2: Specify freeze inputs and non-authoritative candidate output

- [x] Add versioned review-receipt, authorization-claim, and evidence-candidate contracts; reserve the final decision path without defining authoritative decision bytes.
- [x] Require bounded canonical JSON bytes and strict runtime validation.
- [x] Bind the manifest digest, both repository-status evidence, all six document objects, terminal review claim and five-input receipt, exact design and benchmark digests, target repository, and authorization-claim digest.
- [x] Label actor and reviewer claims unauthenticated, return only `EVIDENCE_CONSISTENT` plus `REQUIRE_TRUSTED_ATTESTATIONS`, and expose no authoritative `decision: GO`, `status: VERIFIED`, or decision serialization.

## Task 3: Implement the minimum split modules

- [x] Keep filesystem/Git I/O, JSON decoding, manifest verification, and candidate construction in separate focused files.
- [x] Add `.js` runtime bridges and package exports for every public entrypoint.
- [x] Do not expose a CLI that can accidentally write real freeze artifacts.

## Task 4: Verify and review

- [x] Run focused RED/GREEN tests, raw Node entrypoint smoke tests, recursive typecheck, and the complete repository suite.
- [x] Run `git diff --check`, NUL sweep, and source/test file-size audit.
- [x] Obtain an independent hostile review and fix every BLOCKER or MAJOR before committing.
- [x] Stage only this slice, inspect the staged diff, and commit it without touching Fable's worktree.
