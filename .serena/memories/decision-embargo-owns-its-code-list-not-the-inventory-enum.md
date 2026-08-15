# A new refusal code at an EXISTING layer belongs to the new module

When a DoD names a reason code **and** a layer that already exists elsewhere
(here: `RECOVERY_RECONCILIATION_REQUIRED` at layer `RECOVERY_INVENTORY`), the
reflex is to append the code to the layer-owning module's closed code array.

Do not. Two things are being conflated:

- the **layer constant** is shared identity — import it
  (`RECOVERY_INVENTORY_LAYER` from `recovery-inventory-contract.ts:25`), never
  re-declare the string literal;
- the **code vocabulary** is per-module authority — the new module declares its
  own frozen list.

Appending to the existing array costs more than it looks:

1. Closed `ALL`-style arrays are swept by sibling suites (`it.each(CODES)`,
   `toHaveLength(N)`), so one entry reddens files outside the task's owned
   paths — `mem:gotcha-closed-enum-all-array-couples-sibling-tests`.
2. It silently widens scope. If the task says "NOT in scope: class vocabulary",
   editing that vocabulary is the excluded work.
3. It makes the refusal ambiguous about who refused, which is exactly what the
   layer constant exists to keep clear.

Same reasoning already shipped in `activation-ledger-contracts.ts`: it declares
`ACTIVATION_LEDGER_LAYER` disjoint from the store's, keeps its own closed code
list, and preserves the store's upstream code verbatim in a separate `storeCode`
field rather than flattening. Copy that shape: **own code, imported layer,
upstream preserved in its own field.**
