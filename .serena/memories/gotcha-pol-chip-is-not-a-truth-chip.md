# Gotcha: `cr.chip.policy-approved` is NOT a truth chip — exclude it from global chip audits

Control-room spec §3.1 declares a sixth chip id, `cr.chip.policy-approved` ("POL"), described
as "a ◉-with-gear variant of `HUMAN_APPROVED`'s family" for auto-approved decisions.

Two traps sit in that one sentence.

## 1. It contradicts the design on truth, and the design wins

Design 701: an auto-approval's truth class is `DAEMON_VERIFIED`, **never** `HUMAN_APPROVED`,
and "the UI may separately show a `POLICY` actor badge". §14-C6 explicitly leaves the identity
semantics open. So POL marks the deciding **actor**, not the fact's truth class. Rendering an
auto-approved record with a `HUMAN_APPROVED` chip would be the dishonest reading.

Landed shape (`apps/control-room/src/approvals/approval-inbox.tsx`, `PolicyBadge`):
- the record's real truth chip comes from the kernel (`cr.chip.daemon_verified`);
- the POL badge is a separate element carrying the spec's declared id.

## 2. It breaks `cr.chip.*` counting if placed inside a fact wrapper

`mem:convention-control-room-test-id-prefixes` pins **one `cr.chip.*` per `cr.fact.*`**, and
surfaces assert that as an equality, not a find-first. `cr.chip.policy-approved` is not a truth
chip, so it must render **outside every `cr.fact.*` wrapper** — otherwise the equality fails or,
worse, passes while counting a non-chip.

The approvals test pins this directly:

```ts
expect(pol.closest("[data-testid^='cr.fact.']")).toBeNull();
```

**If you ever write an app-wide `cr.chip.*` audit, exclude `cr.chip.policy-approved`** — a
global equality against `cr.fact.*` will fail on any surface showing a policy-decided record.
The model kernel (`packages/control-room-model`) does NOT define this chip; `TruthChipTestId`
has exactly the five truth classes, and `describeTruthClass` must not be widened to add it.
