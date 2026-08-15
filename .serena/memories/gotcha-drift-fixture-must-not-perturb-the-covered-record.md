# A drift fixture built by mutating the covered record tests the wrong guard

Pattern for any "field X of a committed record drifted from observed value Y" guard, where the
record is protected by a digest or a derived id.

## The trap
The obvious drift fixture is "take the coherent record and change field X". But when an upstream
coherence check covers X — in moe-next, `deriveGrantId` covers the whole `EffectIntent`, so
`validateActivationCommit` refuses `ACTIVATION_COMMIT_INCOHERENT` — that check answers FIRST and
the guard under test never executes. Worse, both refusals here carry the SAME layer (`ACTIVATION`),
so a test asserting only the layer stays green while testing nothing.

**Invert it: perturb the OBSERVED side, never the covered record.** Leave the committed record
exactly as the production builder produces it and construct the *matching* case instead. In this
codebase drift is the cheap fixture (the default `makeActivationRequest()` already names
`DIGEST.runtime` while a real prepared runtime does not) and MATCH is the one needing surgery.

## Consequences that generalize

1. **Distinguish co-located refusals by CODE, and prove it.** When two guards share a layer, a
   layer assertion is decorative. Pin the code, and keep a sibling test that still yields the OTHER
   code from the same layer so the pair is demonstrably separable.
   See `mem:refusal-test-answered-by-earlier-guard`.

2. **The matched fixture needs its own positive control.** A matched fixture that is not really
   matched, sitting behind a dead guard, is indistinguishable from a working guard — everything is
   green. Drill it: revert the matched fixture to the plain builder and require the happy path to
   redden. Without that drill the whole task can ship enforcing nothing.
   Cousin of `mem:qa-positive-control-on-an-empty-grep`.

3. **Assert the phase log by exact equality, not by absence.** `expect(log).toEqual(["runtime",
   "validate"])` proves the guard ran after two named phases AND before every later one in a single
   assertion. `expect(log).not.toContain("open")` survives a guard moved three phases too late.

4. **Extract the comparison so one mutation reddens every call site.** Two copies of a `!==` drift
   apart silently: the second site keeps passing after someone edits the first site's code or layer.
   One shared helper makes the "do both sites agree?" question answerable by a single drill — break
   the helper, and BOTH suites must redden. If only one does, the extraction is cosmetic.
   See `mem:qa-prove-composition-by-mutating-the-real-primitive`.

## Sibling operand trap
When the observed side offers several digests, check which one is even *comparable*. In moe-next
`prepared.freshObservationDigest` digests the pinned closure (paths under the pin root) and can
NEVER equal the quote, while `quotedObservationDigest` is the right operand. Picking the wrong one
refuses every correct call — loud, but only if a matched-case test exists.
