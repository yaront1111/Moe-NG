# task-b7049554 handoff — context/review runtime bridges

Implemented and verified the complete runtime-bridge sweep for `@moe/context` and `@moe/review`.

## Delivered bytes

- Context: 8 exact LF one-line bridges, covering every non-test module.
- Review: 6 exact LF one-line bridges, covering every non-test module.
- Added `packages/context/src/runtime-entrypoint.test.ts` and `packages/review/src/runtime-entrypoint.test.ts`.
- Each test launches a real Node child with `--experimental-strip-types`, imports the bare package self-reference, and asserts both `outcome: "IMPORTED"` and one defined named function.
- No existing TypeScript source was modified.

## Evidence

- Initial plain Node failures: `context-contract.js` and `review-findings.js`, both literal `ERR_MODULE_NOT_FOUND`.
- Final plain Node: context 19 exports / 0 undefined; review 23 / 0 undefined; scheduler regression control 36 / 0; deliberate negative `ERR_MODULE_NOT_FOUND`.
- Final audit: context production=8/bridges=8; review production=6/bridges=6; `MISSING=0 UNEXPECTED=0 BADCONTENT=0 CRLF=0`.
- Mutation: deleting `review-findings.js` produced exactly one MISSING; exact bytes restored.
- TDD red: deleting `context-contract.js` made the new context runtime test fail with structured `ERR_MODULE_NOT_FOUND`; restore then green.
- Focused gate: context 5 files / 24 tests, review 3 files / 91 tests, both typechecks exit 0. Baselines were 4/23 and 2/90.
- Broader `pnpm test`: 167 files, 3033 passed, 1 skipped, exit 0.

## Attribution hazard

Moe completion-hook commit `a6e46f6`, titled for task-386fcb4c, swept these 16 unstaged owned files mid-task together with extensive foreign WIP. Do not revert and do not manufacture a no-op. Review the exact owned change via:

```
git diff a6e46f6^ a6e46f6 -- packages/context/src packages/review/src
```

That path-limited diff contains exactly 16 additions and zero modified `.ts` files. Attribution alert posted to #general as `msg-e565180a348c41029c999708115d40bf`. This follows `mem:gotcha-completion-hook-commits-whole-tree`.
