# A localeCompare mutation drill is vacuous unless the fixture names can distinguish it

Measured on task-d7da9be4.

DoD required deterministic ordering across locales, and the drill was "replace
the codepoint comparator with `localeCompare`; the determinism test must go red."

`localeCompare` and codepoint order **agree** on lowercase hex, digits, and
plain lowercase ASCII. So a fixture built from sha256 addresses
(`[0-9a-f]{64}`) or staging temps (`<16hex>.<n>.tmp`) cannot kill that mutation
— the drill passes green and the DoD reads as proven while nothing was proven.

Names that DO distinguish (en-US ICU vs code points):

- `Zeta` / `alpha` / `base` — code points order `Z`(0x5A) < `a`(0x61) < `b`(0x62);
  en-US collation orders `alpha` < `base` < `Zeta`.
- `Vendor/one` / `assets/two` — same mechanism.

Two further traps found while doing this:

1. **Assert against the enumerator, not the report.** The aggregate re-sorts
   items with its own codepoint comparator, so a report-level order assertion
   stays green no matter what the enumerator did. Call the production enumerator
   directly and assert ITS returned order.
2. **Say so when the fixture can't kill it.** Record in the step note which
   module the drill actually covers. Claiming a drill your fixture cannot kill is
   the same defect class the rail exists to prevent.

Related: `mem:gotcha-empty-absent-unreadable-need-three-answers`,
`mem:qa-generated-table-cannot-police-its-own-generator`.
