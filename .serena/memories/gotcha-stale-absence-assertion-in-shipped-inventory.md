# An assertion can encode an absence that has since been filled

`tests/integration/distribution/distribution-packaging.test.ts:209-211` asserts

```
expect(INVENTORY.some((entry) => entry.componentKind === "IDE_ADAPTER")).toBe(false);
```

under a comment (line 66) explaining *"IDE_ADAPTER is deliberately ABSENT: `adapters/` does not exist"*.
`adapters/jetbrains` and `adapters/ide-contract` both exist now and their producer task is DONE. The test is
green, correct-looking, and actively **guards the gap shut**.

This is the re-measure rail's second direction — GAP CLAIMED PRESENT, actually closed — but hidden inside a
passing assertion rather than a task description. A worker who trusts the green suite concludes the absence
is intended.

**When planning any task that fills a known-absent slot, grep the test tree for an assertion that pins the
absence** (`toBe(false)`, `not.toContain`, `=== 0`, `.length).toBe(N)` on a hand-written inventory). Plan the
inversion explicitly as an owned edit. Two follow-on rules:

1. Inverting `some(...) === false` into `some(...) === true` trades one weak assertion for another. Assert
   the strong form: exactly one entry of that kind, its id is the expected one, and **every asset path it
   names resolves on disk with non-empty bytes** — that is what stops a placeholder creeping back in.
2. Hand-transcribed sibling lists (componentIds, kinds, counts) live nearby and must be updated in the same
   edit; they are deliberately hand-written so they redden, and that is a feature.

Related: `mem:closed-verdict-map-forbids-a-new-test-file`, `mem:qa-generated-table-cannot-police-its-own-generator`,
`mem:moe-blocked-shell-reserved-as-planning`.
