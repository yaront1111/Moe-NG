# Pinning a digest contract that no ordinary test failure would catch

A change to canonicalization or manifest shape silently invalidates every piece of
existing evidence that recorded a digest, and a green suite never notices — nothing
compares today's digest to yesterday's.

**Do not pin an end-to-end digest.** In `@moe/store` the generation digest folds in
`databaseDigest`, taken from a captured SQLite image, so a hardcoded end-to-end value
drifts with the host's sqlite build.

Pin a FIXED manifest literal through the production pure function instead:

```ts
const DIGEST_FIXTURE = Object.freeze({ cursor: "7", databaseDigest: "a".repeat(64), ... });
expect(computeGenerationDigest(DIGEST_FIXTURE as unknown as Parameters<typeof computeGenerationDigest>[0]))
  .toBe("ee01db282f980d87d67ec3c971e31885f6ecaa4ab49aabaf76fbeb80633346c3");
```

Two things the pin alone does NOT give you:

1. **Proof the value is unchanged rather than merely recorded.** You computed it by
   running the code you just wrote. The independent proof is
   `git diff --stat -- <the digest-defining modules>` being EMPTY — the digest is
   produced by bytes the task never touched. State that, not "I verified the digest".
2. **A field added to the manifest but omitted from the canonical projection** changes
   the contract without moving the digest. Pair the digest pin with a field-set
   assertion on a REAL produced manifest, and assert the FIXTURE has the same field set
   — otherwise the fixture drifts and the digest pin quietly tests a shape production no
   longer emits.

Descriptor digests need 64 lowercase hex: `String(index).repeat(64)` is valid and
distinct per entry.

Related: `mem:layered-validator-sweep-goes-vacuous`, `mem:canonical-json-needs-digest-and-reencode`.
