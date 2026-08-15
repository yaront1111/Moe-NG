# Adding one field to a closed record is a five-site edit, and the two worst sites are silent

Measured in @moe/runner's `ClaudeLaunchRequest`, but the shape recurs anywhere a repo pairs an
interface with a hand-maintained key list.

## The sites
1. The interface itself. Obvious.
2. **The runtime key list** (`REQUEST_KEYS`, consumed by `snapshotExactRecord`). It LENGTH-CHECKS
   `Object.keys` against the list, so an interface field without a key entry — or a key entry
   without a field — makes EVERY record refuse. Not the new path. Every path.
3. Any compile-time `satisfies Record<keyof X, unknown>` literal. Loud, at least.
4. Test fixtures whose return type is annotated `X`. Also loud.
5. **Any literal that both constructs X and EXECUTES the production entry point**, pinning an
   outcome from a LATER phase. A new early gate preempts it.

## Why 2 and 5 are the dangerous ones

**Site 2 fails totally but anonymously.** If the module holding the key list has no test of its
own, the symptom is a wave of generic `*_MALFORMED` refusals in unrelated suites — never a named
failure pointing at the key list. Check for a dedicated test before trusting that a drift will
announce itself; here `ls providers/claude/*.test.ts` showed seven files and none for the input
module. Guard it with an explicit assertion that the key-list length equals the field count.

**Site 5 tempts you into retiring someone else's assertion.** A literal doing
`launchClaude({...,argv: []})` and pinning `{GRANT_WRAPPER_MISMATCH, GRANT}` starts failing when a
pre-open gate lands. The wrong repair is to change the expectation to the new gate's code — that
silently deletes a grant-layer test. The right repair is to make the INPUT valid enough to still
reach the original subject. Same family as
`mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`.

## Corollary: adding an early gate makes every later-phase test conditional
Count the call sites of the shared request fixture first. If N tests build from a default fixture
and pin codes from later phases, a gate that refuses that default flips all N at once and each one
silently stops testing its subject. Two options: make the default fixture satisfy the gate (cheap,
one edit) or pass explicitly at every site (here ~57). Take the cheap one, then prove the gate is
not answering for the others with a drill that DELETES the gate and requires the pre-existing cases
to stay green.

## And check whether the payload record downstream is also closed
A second `snapshotExactRecord`-style closed record can sit further down the same call path — here
`windows-launch-request.ts` pins exactly four keys in production. New data cannot ride on that
payload at all; it must ride on an already-opaque field (a bounded `string[]`) or stay upstream.
Grep for every exact-record key list on the path, not just the one you are editing.

## Free-vs-expensive, worth measuring before choosing
Appending to a closed CODE or LAYER vocabulary can be free — grep every reference for `.length`
and `.toEqual` first. In this repo two 93- and 17-member launcher vocabularies had zero such
guards, while the sibling `SUPERVISOR_ERROR_CODES` had a closed-set REACHABILITY sweep where a new
member must actually be RETURNED by a production refusal. Same-looking arrays, opposite cost.
Options bags are often not exact-key-closed while requests are — check, because that asymmetry
decides where new configuration should live.
