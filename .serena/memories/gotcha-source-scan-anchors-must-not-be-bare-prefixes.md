# A source-scan anchor that is a bare identifier survives a rename

Found by mutation drill on `task-a7ba291edeb3461f9c5305bc91f0810f`
(apps/control-room recovery/doctor import ban). The scan looked right, passed, and was
one rename away from testing nothing.

## The shape

Structural import-ban tests (`data/data-ban.test.ts` and every copy of it) prove a
NEGATIVE property, so `not.toContain` assertions are vacuous unless something proves the
file was actually read. The standard guard is a positive anchor:

```ts
const source = readFileSync(join(dir, name), "utf8");
expect(source).toContain("export function RecoveryExternalInventory");  // <-- rotten
expect(source).not.toContain("fetch(");
```

Rename the export to `RecoveryExternalInventoryRenamed` and the anchor STILL MATCHES —
it is a prefix of the new name. The drill mutant survived. The anchor therefore does not
prove the module still exports what the ban is about; it only proves some file with a
similar-looking string was read.

## Fix

Terminate the anchor with a character the identifier cannot contain:

```ts
expect(source).toContain("export function RecoveryExternalInventory(");
```

The paren kills the rename. Same idea for class/const anchors: `export const FOO =`,
`export class Foo {`.

## The general rule

An anchor must be falsifiable by the smallest edit you actually fear. Ask "what one-token
change would make this file wrong, and does the anchor go red?" A bare identifier fails
that test against renames, suffixes, and re-exports.

Two related vacuity traps in the same family, both worth asserting alongside:
- assert the scanned FILE SET equals an exact list, so a new production file cannot slip
  past the ban by being added (drill: create `zz-probe.ts`, expect red);
- assert `source.length` is above a floor, so an empty or wrong-path read cannot pass.

Related: `mem:gotcha-import-meta-url-is-http-in-tsx` (the wrong-path half of this
failure), `mem:pattern-import-ban-scans-specifiers-not-text`,
`mem:pattern-guard-the-case-list-not-just-the-cases`.
