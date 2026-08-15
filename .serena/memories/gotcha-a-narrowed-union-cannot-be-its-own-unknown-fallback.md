# A narrowed union arm cannot serve as its own UNKNOWN fallback

`ClaudeDeclaredSelection` is `{known:true, selection} | ProviderFactUnknown`.
Inside `if (!declared.known) { ... } ` the false arm is a usable
`ProviderFactUnknown` and forwarding it verbatim is correct. But in the TRUE
branch, TypeScript has narrowed `declared` to the known arm, so passing it as the
`absent: ProviderFactUnknown` argument of a reader fails with

    TS2739: Type '{ readonly known: true; readonly selection: ... }' is missing
    the following properties from type 'ProviderFactUnknown': code, layer

seven times in one file. The fix is NOT to widen the parameter (that would let a
known fact be handed in as an absence). Declare a module constant carrying the
same reader's own code:

    const SELECTION_UNREADABLE: ProviderFactUnknown =
      unknownFact("TELEMETRY_DECLARED_SELECTION_UNREADABLE", "TELEMETRY_INPUT");

Unreachable by construction (the selection reader admits no empty field), and it
keeps the SELECTION layer's code rather than borrowing a launch-side one — which
matters, because a test can then assert WHICH layer answered per field family.
Landed in `packages/runner/src/providers/telemetry/provider-run-record.ts`.
