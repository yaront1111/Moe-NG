# The project-configuration `limits` table is dense and POSITIONAL, so "reorder it" is unreachable

Measured 2026-08-15 at HEAD 192360e in `packages/contracts/src/configuration/project-configuration-parser.ts`
(`parseLimits`).

`PROJECT_CONFIGURATION_LIMIT_KEYS` has **30** members and their order is part of the contract. The
parser requires `value.length === 30` **and** entry `i` to already carry key `i` — nothing is sorted,
nothing is filled in. Consequence for anyone writing a digest/codec over
`ProjectConfigurationSettings`:

**A reordered limits table is REFUSED BY THE CONTRACT and can never reach a digest.** A plan step
that says "reordering two limit entries must change the digest" is not reachable through
`createProjectConfigurationManifest`/`parseProjectConfigurationSettings` — the manifest never
constructs. Reachable substitutes that still kill a "sort arrays too" canonicalizer mutant:
- assert on the **encode output bytes** that the 30 keys appear at strictly increasing offsets in
  `PROJECT_CONFIGURATION_LIMIT_KEYS` order. The vocabulary is *not* alphabetical (it opens
  `providerSlotsPerProject, providerSlotsPerGoal, expansionDepthMax, ...`), so a canonicalizer that
  sorted arrays would reorder them and the assertion reddens.
- a decode case over reordered-limits bytes, pinning the contract's own
  `PROJECT_CONFIGURATION_INPUT_INVALID` / `PROJECT_CONFIGURATION_MANIFEST` forwarded as upstream —
  never re-coded into a codec code.

**Two more leaves with no representable valid single-field mutation**, which matters for a
"every valid leaf mutation changes the digest" sweep:
- `orchestrationSource.objectFormat` — `SOURCE_SHA_LENGTHS` is `sha1: 40, sha256: 64`, so flipping
  the format alone invalidates `sourceSha`.
- `policy.autoApprovalOptInDigest` from an all-manual fixture — `parsePolicy` refuses a non-null
  digest when no gate is `POLICY_AUTO_APPROVAL_OPT_IN`. Base the sweep on a fixture with **two**
  gates set to `POLICY_AUTO_APPROVAL_OPT_IN` and all four gate/digest leaves gain a valid mutation.

Shape facts: `ProjectConfigurationSettings` has exactly 7 fields; `ProjectConfigurationManifest`
exactly 4. `settingsDigest` lives on the MANIFEST only, so hashing the settings value excludes it
structurally — there is no filter to forget.

Related: `mem:gotcha-refusal-code-absent-from-test-file`.
