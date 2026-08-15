# A digest-first decoder makes every structural sweep vacuous unless you recompute

Learned on `task-584f4af0` (2026-08-11) writing
`packages/store/src/recovery-install-codec.ts`.

## The setup

A fail-closed byte decoder that checks the recorded digest BEFORE parsing:

```ts
if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return BYTES_MALFORMED;
if (!isDigestRef(expected) || digest(bytes) !== expected) return DIGEST_MISMATCH;
if (!hasHeader(bytes)) return CODEC_VERSION_UNSUPPORTED;
// ...framing, bounds, trailing-byte and field checks below here
```

Digest-first is the RIGHT production order — you should not parse bytes you have
not integrity-checked.

## The trap

The obvious test sweep mutates the bytes and passes the ORIGINAL digest:

```ts
for (const t of truncations) expect(decode(t, originalDigest).ok).toBe(false);   // WRONG
```

Every case refuses, the sweep is green, and **not one of the structural guards
below the digest check ever runs.** Delete the trailing-byte check, the bounds
check, the header check — the sweep stays green. It is testing the digest gate
sixty times over.

Same failure family as `mem:refusal-test-answered-by-earlier-guard`: an earlier
guard answers first and the test reads as coverage.

## The fix, both halves

1. **Recompute the digest for the mutated bytes** in every structural sweep, so
   the integrity gate passes and the structural guard is genuinely reached:
   ```ts
   const result = decodeRecoveryBinding(truncation, recoveryBindingDigest(truncation));
   ```
2. **Pin the ORDER with its own named test**, or nothing stops a later refactor
   from silently reversing it:
   ```ts
   it("answers a stale digest before it parses, and says so", () => {
     const stale = decode(bytes.subarray(0, bytes.length - 1), digest(bytes));
     expect(stale.code).toBe("RECOVERY_BINDING_DIGEST_MISMATCH");   // NOT bytes-malformed
   });
   ```

Half the fix is not enough. Recomputing without pinning the order means a future
digest-last refactor goes unnoticed; pinning without recomputing means the
structural guards stay untested.

## Generalisation

Any layered validator — auth then parse, schema then semantics, checksum then
decode — has this shape. When you write a sweep against layer N, construct the
input so layers 1..N-1 PASS. If you cannot construct such an input, layer N is
unreachable and should be deleted rather than tested.

Related: `mem:qa-deviation-fixture-must-be-valid-at-earlier-layers` (the QA-side
statement of the same rule), `mem:mutation-drill-red-on-wrong-assertion`.
