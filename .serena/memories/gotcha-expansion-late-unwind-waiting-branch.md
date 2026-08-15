# Expansion late-unwind drill targets the WAITING branch

`tests/integration/expansion-protocol.test.ts`'s named late-reservation case uses a resource capacity snapshot of zero. `reserveAll` returns an ok result whose outcome is not `RESERVED`; it does not take the `!acquired.ok` branch. Therefore mutating the error-branch `unwound(...)` call will not redden `gives the reserved units BACK...`.

For this invariant, mutate the `acquired.value.outcome !== "RESERVED"` branch (temporarily return the local refusal without `unwound`) and expect the named assertion to fail at `budgetReservationCancelled` with `expected false to be true`. Restore and hash-check the source afterward.