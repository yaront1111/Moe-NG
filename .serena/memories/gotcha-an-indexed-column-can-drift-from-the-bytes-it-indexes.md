# An indexed column can drift from the bytes it indexes, and the digest cannot see it

Found by adversarial self-review on `task-584f4af0` (2026-08-11), in
`packages/store/src/recovery-install.ts`, BEFORE it shipped.

## The shape

A durable row stores authoritative BYTES plus a digest over those bytes, and
ALSO copies a few values out of the bytes into their own columns so they can be
indexed or queried:

```sql
CREATE TABLE recovery_bindings (
  slot TEXT PRIMARY KEY,
  incarnation_ref TEXT NOT NULL UNIQUE,   -- also inside binding_bytes
  key_epoch_ref TEXT NOT NULL,            -- also inside binding_bytes
  binding_codec_version TEXT NOT NULL,    -- also inside binding_bytes
  binding_digest TEXT NOT NULL,           -- sha256(binding_bytes)
  binding_bytes BLOB NOT NULL
) STRICT
```

## Why it is invisible

`binding_digest` covers `binding_bytes` ONLY. Change a COLUMN and the bytes and
their digest still agree perfectly, so every integrity check passes. The decoder
returns a valid binding. Nothing notices that the row is filed under a different
incarnation than the one it actually carries.

**The damage is not cosmetic.** `UNIQUE` is enforced on the COLUMN. If the column
can disagree with the bytes, then "one incarnation cannot occupy both slots" was
only ever a guarantee about the INDEX, never about the bindings. The structural
protection you thought you had is protecting a value nothing ties to the content.

Same family as `mem:gotcha-a-digest-can-mask-every-field-it-covers` and
`mem:guard-premise-detaches-while-green`: an assertion quietly detached from its
subject.

## The fix

On every read, compare EVERY column that duplicates the bytes against the DECODED
value, and refuse the row whole with its own stable reason code
(`RECOVERY_BINDING_ROW_DIVERGED`) — never reconcile toward either side, and never
prefer the column just because it is cheaper to read.

```ts
const decoded = decodeRecoveryBinding(row["binding_bytes"], bindingDigest);
if (!decoded.ok) return decoded;
if (!rowMatchesBinding(row, slot, decoded.binding)) return RECOVERY_BINDING_ROW_DIVERGED;
```

The bytes are the authority; a duplicated column is only an index INTO them.

## Testing it

The drift test must move ONLY the column, through a second raw connection, leaving
`binding_bytes` and `binding_digest` untouched — otherwise the digest gate answers
first and the guard is never reached (`mem:refusal-test-answered-by-earlier-guard`).
Assert the exact code AND the refusing layer, per-column.

Then drill it: delete the added comparisons and confirm the test reddens. Without
the drill, a "row matches" helper that silently only checks the primary key reads
exactly like full coverage.

## The general rule

Whenever you denormalise a field out of an authoritative blob into a column,
you have created two answers to one question. Either check them against each
other on read, or do not create the column.
