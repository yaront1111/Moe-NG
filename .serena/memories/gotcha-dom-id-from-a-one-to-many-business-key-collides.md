# A DOM id built from a business key collides when that key is one-to-many

Found by adversarial self-review on task-371c80bd (live control-room timing
consumer edge), 2026-08-15, in my own work — every test was green.

## The shape

`live-command-timing.tsx` rendered one receipt per event row and addressed it:

    testIdPrefix={`${LIVE_TIMING_PREFIX}.${commandId}`}

which `CommandLatency` expands to `data-testid={`${prefix}.phase.${phase}`}`.

`commandId` reads like a unique key. It is not — **one command emits many
events**, which is the normal event-sourcing shape. Two rows of the same command
therefore painted two receipts, built from two DIFFERENT sets of readings, under
one identical `data-testid`.

## Why the suite could not see it

Every fixture used one event per command, or two events with two DIFFERENT
command ids. The collision needs same-command-different-event, which no test
had. Six tests asserted the receipt rendered correctly and all six passed.

Worse, the failure mode is silent-then-explosive: `getByTestId` THROWS on
multiple matches, so the collision does not surface as a wrong value — the next
test that happens to use a two-event fixture just dies with "found multiple
elements", far from the cause.

## How to prove it rather than argue it

A throwaway probe through the real production surface, not a unit test:

    render(<ClockProvider clock={...}><LiveControlRoom setup={setupWith([
      eventRow("evt-1"), eventRow("evt-2")])} /></ClockProvider>)
    console.log(screen.getAllByTestId(id).length)   // -> 2

Delete the probe immediately; `getAllByTestId` (not `getBy`) is what lets you
COUNT the collision instead of throwing on it.

## The rule

An identifier built from a domain field is unique only if that field is unique
**per rendered node**. Before using one, ask what the field's cardinality to the
rendered thing actually is:

- command -> event is one-to-many
- aggregate -> event is one-to-many
- user -> session is one-to-many

Fix by APPENDING the discriminator, never by replacing the business key:
`cr.live.timing.<commandId>.<eventId>`. The business key is what ATTRIBUTES
(which command is this receipt about); the discriminator is what
DISAMBIGUATES. Dropping the command id would have made the receipt
unattributable, and deduping rows by command id would have DISCARDED
observations — both worse than the collision.

Cost of the fix is real but small: every test helper that builds the id gains a
segment. Budget for touching `phaseId`-style helpers in each consumer spec.

Related: `mem:convention-control-room-test-id-prefixes`,
`mem:gotcha-joined-identity-keys-collide`.
