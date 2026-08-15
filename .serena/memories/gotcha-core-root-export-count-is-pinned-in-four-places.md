# Publishing a symbol from the @moe/core root reddens FOUR pins, not one

Measured landing task-5d8f11c8 (commit 18f0964), which added 5 root exports (75 -> 80).

An architect's plan named only `index-surface.test.ts:108`. Updating that alone left the suite
red twice more. The complete set:

1. `packages/core/src/index-surface.test.ts` — the hand-written `EXPECTED_EXPORTS` catalogue.
   Entries must be in **JS default sort order** (`Object.keys(core).sort()`, UTF-16 code units,
   so all UPPERCASE names sort before lowercase). Each entry declares an `ExportKind`
   (`"array" | "function" | "record" | "string"`).
2. `index-surface.test.ts` — `expect(EXPECTED_EXPORTS.length).toBe(N)`.
3. `index-surface.test.ts` — `namedExportCount: N` **inside the child-process strip-types
   probe's `toEqual`**, near the bottom of the file. Easy to miss: it is a bare number inside a
   large object literal, not an obvious count assertion.
4. `packages/core/src/supersession/supersession-engine.test.ts` — a SIBLING suite in a different
   directory independently asserts
   `Object.keys(core).filter((key) => key !== "default").length).toBe(N)`.
   Its own comment says it stays a count "so a rename cannot pass both", i.e. it is deliberately
   coupled to the root surface. Nothing in the planning/ or index-surface files points at it.

## The sweep that finds them all

    grep -rn "toBe(75)\|namedExportCount: 75" --include='*.ts' packages apps | grep -v '/dist/'

Run it with the OLD count after editing; zero hits means every pin moved. Related:
`mem:gotcha-closed-enum-all-array-couples-sibling-tests` — same shape, a closed vocabulary
coupling suites that never import each other.

Type-only exports are invisible to all four (they are runtime-value counts) — see
`mem:type-only-export-invisible-to-count-test`.
