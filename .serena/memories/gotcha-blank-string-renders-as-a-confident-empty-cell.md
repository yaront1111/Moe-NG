# `value ?? UNKNOWN` lets a blank string render as a confident empty cell

Found by adversarial self-review on `task-d99ca771`, in two control-room surfaces I had
just written and drilled. The mutation drill did NOT catch it — no mutant expresses it,
because the bug is a missing case rather than a wrong one.

## The shape

```tsx
<dd data-provenance={statedProvenance(value)}>{value ?? UNSTATED}</dd>
```

`??` only catches `null`/`undefined`. A daemon payload carrying `""` or `"   "` renders an
EMPTY cell tagged `data-provenance="DAEMON_STATED"` — a confident provenance marker
attached to nothing. On an evidence surface that is worse than UNKNOWN: UNKNOWN says the
daemon was silent, blank-plus-STATED says the daemon asserted emptiness.

`apps/control-room/src/nodes/node-authority.ts` already had this right on the fact path,
and says so:

```ts
// Whitespace counts as absent: a blank-looking value beside a confident chip is
// exactly the "never blank" case the spec forbids.
return typeof value === "string" && value.trim() !== "" ? value : null;
```

New cell renderers written from scratch reintroduce it, because the guard lives inside
`readValue` and is invisible unless you route through `FactRow`.

## Fix

One helper next to the provenance vocabulary, used for BOTH the display text and the
provenance attribute so the two can never disagree:

```ts
export function statedValue(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}
```

Same class of bug in link builders: a blank id is not a name. `#timeline/${eventId}` with
`eventId === ""` yields `#timeline/`, presenting unreachable evidence as reachable.
`node-evidence.EvidenceLink` guards this with `.trim() !== ""`; new link renderers must
too.

## Why the drill missed it, and what does catch it

A mutation drill perturbs code that EXISTS. It cannot surface a case the author never
considered. Only reading the diff adversarially — "what if this string is empty?" — found
these. Run the input checklist (null / empty / zero / NaN / huge / malformed) against every
new renderer even when every mutant died.

Related: `mem:gotcha-vacuous-set-membership-clears-everyone`.
