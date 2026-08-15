# Gotcha: `Object.hasOwn(array, i)` cannot be killed by an ordinary sparse-array test

A positional array parser that guards density with

```ts
if (!Object.hasOwn(value, index)) return undefined;
const entry = value[index];
if (!isPlainRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS, [])) return undefined;
```

looks well covered by a `delete limits[3]` hostile case. It is not. Deleting an element
leaves a hole, `value[3]` reads back as `undefined`, and `isPlainRecord(undefined)` already
refuses. **Delete the `hasOwn` line and the whole suite stays green** — measured on
`packages/contracts/src/configuration/project-configuration-parser.ts`, 416/416 passing with
the guard removed.

The guard is not dead code; it is the only defense against a polluted `Array.prototype`
filling the hole with a valid-looking entry. The case that can kill it:

```ts
const filler = { key: EXPECTED_LIMIT_KEYS[3], value: 3 };
Object.defineProperty(Array.prototype, 3, { configurable: true, value: filler, writable: true });
let result;
try { result = parseProjectConfigurationManifest(input); }
finally { delete (Array.prototype as unknown as Record<number, unknown>)[3]; }
expect(Object.hasOwn(Array.prototype, 3)).toBe(false);   // restore actually happened
expect(result.ok).toBe(false);
```

Keep the polluted window to exactly the parser call and assert AFTER the restore — a global
`Array.prototype` index is visible to vitest's own arrays and will corrupt unrelated
assertions if it is still installed while they run.

## The general rule

Before believing a surviving mutant is an equivalent mutant, ask which OTHER guard answered
first. Two outcomes, and they need opposite fixes:

- genuinely redundant (a second operand inside one guard) -> the mutant is equivalent, say so;
- redundant only for the inputs your table happens to contain -> the guard defends a case you
  never wrote, and the fix is a new test, not deleting the guard.

Same shape appeared on the length check in that file: mutating `length !== N` to `length > N`
also survived, because the short direction is answered by this same density guard. Mutating it
to `length < N` reddened two rows (`a table one entry long`, `a duplicated entry`), which is
the direction that actually pins the equality.

See `mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`,
`mem:gotcha-unreachable-guard-needs-a-direct-production-pin`,
`mem:gotcha-equivalent-mutant-vs-uncovered-branch`.
