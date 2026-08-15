# An exact-keyed registration seam cannot carry a refusal code — return two things

Measured on task-d7da9be4, `packages/runner/src/recovery-inventory/`.

## The trap

DoD said "an entry whose name is not a valid content address is REPORTED WITH A
STABLE CODE rather than silently skipped." The obvious move is to put the code on
the value the enumerator returns. You cannot.

`RecoveryInventoryPortReading` is a closed three-shape union
(`ENUMERATED{items,complete,negativeProofDigest} | UNAVAILABLE | UNSUPPORTED`),
and `readPortResult` uses `exactRecord` — an extra key makes the whole reading
unreadable, which the aggregate turns into `RESULT_MALFORMED`. The registration
is worse: `readRegistry` runs `exactRecord(entry, ["class","enumerate"])` and
returns **null for the entire registry** on any extra field, so one decorated
registration refuses every class's collection, not just its own.

## The shape that works

Give the production enumerator a wider return than the seam consumes:

```ts
export interface ArtifactObjectInventoryReading {
  readonly reading: RecoveryInventoryPortReading;   // what the seam gets
  readonly refusal: ArtifactEnumerationFailure | null;  // verbatim code + layer
}

export function artifactObjectInventoryRegistration(input) {
  return Object.freeze({
    class: CLASS,
    enumerate: (context) => enumerateArtifactObjectInventory(input, context).reading,
  });
}
```

The registration stays exactly two keys; a caller that wants the underlying code
calls the enumerator directly. Tests then assert BOTH levels: the aggregate's
`{truth, code, reason, layer}` AND the pass-through
`RUNNER_ARTIFACT_ADDRESS_CORRUPT @ ARTIFACT_STORE` vs
`RUNNER_ARTIFACT_VERIFY_FAILED @ ARTIFACT_FS_PORT`.

## Why it matters for review

This reads like gold-plating if you don't know the seam is exact-keyed. It is
the opposite — it is the only representable way to satisfy "name the code" when
the transport union is closed. Say so in the handoff or QA will ask you to
delete it.

Related: `mem:gotcha-empty-absent-unreadable-need-three-answers`.
