# "The drill must redden on MANY fields" is unobservable by default

A per-field mutation sweep looks like this:

```ts
for (const key of RECORD_KEYS) {
  const decoded = decode(forge(key))
  expect(decoded.ok, `field ${key} escaped the digest`).toBe(false)
  if (decoded.ok) continue
  expect(decoded.code).toBe("DIGEST_MISMATCH")   // <- HARD assert, throws
  swept += 1
}
expect(swept).toBe(RECORD_KEYS.length)
```

Disable the production guard and run it: **you see exactly one failure**, for the
first key. `expect` throws, so the loop aborts. That single red is
indistinguishable from a sweep that has quietly stopped sweeping — the exact defect
the "redden on many fields" rule exists to catch.

## How to actually observe it

Temporarily convert BOTH loop assertions to `expect.soft(...)` — soft assertions
record and continue — then run the drill. Restore afterwards and prove it with
`grep -c "expect.soft" <file>` == 0 plus a sha256 check.

Two soft edits are needed, not one. Softening only the `ok` assertion still aborts
at the second key, because a field that fails *differently* (e.g. a pinned literal
refused by a later guard) trips the hard `code` assertion instead.

Real result from doing this on a 12-field record with both digest guards disabled:
10 fields escaped decode entirely, 2 (the pinned version literals) refused with the
WRONG code. All 12 red — a genuine sweep. Without the soft edits the same drill
printed one failure.

## Also

Disabling one digest guard can be answered by another. Here, killing the
digest-before-framing check let the decode's re-encode check answer instead, so the
drill reddened on the CODE assertion
("expected RECORD_MALFORMED to be DIGEST_MISMATCH"). That is a *better* red — it
proves which guard must answer — but it is not proof the sweep is broad. Do both.

Related: `mem:qa-generated-table-cannot-police-its-own-generator`,
`mem:layered-validator-sweep-goes-vacuous`
