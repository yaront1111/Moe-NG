# Plan handoff — bounded activation-ledger aggregate identifiers

- Approved task: `task-8f84c56d88504f80aa2fefdf69f093bd`.
- Owned paths: `apps/daemon/src/activation/activation-ledger-contracts.ts` and new `apps/daemon/src/activation/activation-ledger-aggregate-id.test.ts` only.
- Preserve the complete current namespaced length-framed identifier byte-for-byte when its UTF-8 encoding is <=512 bytes. Hash only overflow as `moe-activation-ledger/1|aggregate|sha256:<64 lowercase hex>`, hashing the complete framed legacy preimage.
- Fresh source measurement: contracts file was 244 lines and clean; derivation returned the framed string verbatim. Current fixture literal is `moe-activation-ledger/1|aggregate|18:effect-aggregate-1|10:idem-key-1` (69 bytes). Exact 512-byte boundary is `a`*200 / `b`*269.
- Overflow exact vectors: ASCII max digest `bdd4da6783d902fb5f8b32dd80ab9d6eb2ce872584cac2b7c03baa7bff881dc4`; multibyte max digest `c2c6dfeaf460969855dc3f31ef92ee3169ad2e3a04c38caa79f630cd4a9ffe42`.
- Bare-concatenation collision pair (`x`*399, `x`*400) vs (`x`*400, `x`*399) must remain distinct; framed digests are `2f8707d26da0515f83b21cacee2e29ee339ed1c13a2f3bb3ac78e7bbabaee6a0` and `f5d4c1cb9d030deb779e5cfb34d55febee5c6193809c756a25116e9eea3fbcb5`.
- Both @moe/runner and @moe/store dependency edges were verified via daemon manifest, lockfile importer, and a deleted in-package bare-specifier typecheck probe.
- Tests must use public `parseEffectIntent`, real file-backed `SqliteEventStore`, production commit, close/reopen, exact nonzero cardinalities, and hardcoded vectors rather than a test-side hash oracle.
- Active sibling work owns `activation-ledger-commit.ts` and its existing test; never edit, stage, or restore those paths.
- Mutation drills: (1) overflow returns legacy must make named max/file-store test red; (2) bare-concatenation digest must make named framing test red; out-of-repo backup and byte-exact hash restoration required.
- Exact completion gate: `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test`, with positive nonzero test counts. Architect shell lacked executable pnpm, so worker must supply fresh evidence.
- See the approved six-step Moe implementation plan for baseline attribution, TDD sequence, and adversarial review details.