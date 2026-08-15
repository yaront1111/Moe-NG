# Canonical inventory migrations must trace every count consumer

Replacing a duplicated component list with one canonical inventory is not complete after direct importers agree. Search all downstream production guards and release/evidence tests for hard-coded cardinalities.

Live example: release-subject moved from five to six components and the focused 51-test distribution suite passed, but `scripts/release/supply-chain.mjs` still enforced `subject.componentCount !== 5` and emitted `componentCount: 5`. The final integration command therefore mapped the correct six-component subject to the stable `RELEASE_INVENTORY_EMPTY` refusal. Its Node suite also had ten five-count pins.

Planning rule: when a canonical inventory changes cardinality, grep both the exported symbol and literal count comparisons in every real consumer. Include production guard/emission paths and the separately-run test lanes, not only the suite that owns the inventory. If those paths are outside ownership, amend scope before implementation rather than fabricating a compatibility view.