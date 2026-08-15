# Convention: the <=250-line rail beats a plan's module count

Epic rail: "Keep each production source focused, target <=250 lines, and split before 400."
It is a hard constraint. When an approved plan names a specific number of modules or test
files and the honest implementation exceeds 250 lines, **split and record the deviation in
the step note** — do not compress by weakening coverage or deleting comments.

Precedent (task-12e18265f7a84c7eacdf79a3bef2bdf3, commit `88e92a4`), all three splits
accepted:

| Planned | Actual size | Split into |
|---|---|---|
| 1 test file | 354 | `runtime-contract.test.ts` 189 + `runtime-envelope.test.ts` 250 |
| 1 model module | 321 | guards 84 + vocabulary 140 + affordance 138 |
| 1 registry module | 284 | registry table 186 + error factory 104 |

Split along a real seam (structural guards / vocabulary / builder; table / construction),
not at an arbitrary line number.

## Cross-platform line-count gate

`wc -l` is not available everywhere and miscounts a file without a trailing newline. Use
Node, which handles CRLF and LF:

```js
const raw = fs.readFileSync(f, "utf8");
const n = raw.length === 0 ? 0 : raw.split(/\r\n|\r|\n/).length - (raw.endsWith("\n") ? 1 : 0);
```

Bridges (`export * from "./name.ts";`) must stay exactly 1 line.

## Compaction moves that buy lines without losing coverage

- Hoist repeated literal arrays out of a loop body to module scope.
- `Object.fromEntries(keys.map(...))` instead of a mutable object plus a `for` loop.
- Table-driven `it.each([...])` with one case per line.

## Typed table helpers (also a correctness fix, not just cosmetics)

Inline `Object.freeze(["session.open"])` inside a table row widens to `readonly string[]`
and silently defeats literal checking against a closed vocabulary. Use typed helpers so
every cell is checked:

```ts
const cmds = (...items: RuntimeCommandKind[]): readonly RuntimeCommandKind[] => Object.freeze(items);
```

This caught real typos at compile time in the error registry table and shortened it.
