# Whole-payload equality across the control-room transport is unconditionally broken by the seam clock

`tests/integration/control-room/control-room-transport.test.ts:135`

```ts
expect(transported.response).toEqual(JSON.parse(JSON.stringify(inProcess)));
```

fails intermittently on `seamObservation.reading.value`. Observed drifts: 606 vs 597 ms
(2026-08-15 13:54), 700 vs 692 ms (14:06). Three sightings across three unrelated tasks.

## Cause (measured, not inferred)

- `apps/daemon/src/http/event-stream.ts:133-137` — `readEventPage(port, request, observer: SeamObserver = DEFAULT_SEAM_OBSERVER)`.
- `event-stream.ts:87` — `const seamReading = observer.now()` inside `pageFrame`.
- `apps/daemon/src/http/http-listener.ts:116` — `reply(response, 200, readEventPage(options.subscriptions, request));`
  Two arguments into a three-parameter function. The observer is **omitted**, so the default fires.
- `apps/daemon/src/http/event-stream-observation.ts:95-97` — `DEFAULT_SEAM_OBSERVER = { now: () => new Date().toISOString() }`.

Daemon side and in-process side therefore each take their own wall-clock reading. The equality
can only pass inside one millisecond. Not flaky-under-load — broken, winning the race sometimes.

## The cheap fix: both readers are in the SAME PROCESS

`control-room-transport.test.ts:116` starts the daemon with `startDaemon(...)` in-process; the
transport is a loopback round trip. `Date` is process-wide, so freezing it makes both readings
identical with no production change and no assertion change:

```ts
vi.useFakeTimers({ toFake: ["Date"] });   // Date ONLY — timers stay real
```

`toFake: ["Date"]` is load-bearing: a bare `vi.useFakeTimers()` also fakes `setTimeout`, and the
test awaits a real HTTP round trip, so faking timers wholesale can HANG it rather than fail it.
(Not yet run — one call from being proven either way.)

## Never delete the field

Subtractive "fix" retires the only assertion catching a transport that drops or renames a payload
field (see `gotcha-verification-proxy-diverges-from-the-property` for the same shape). If you
extract-and-assert instead of freezing the clock:
- assert `Object.hasOwn` on BOTH payloads before removing — the assertion is `toEqual`, not
  `toStrictEqual`, and `toEqual` treats a key set to `undefined` as equal to an absent key, so
  extracting by assignment silently retires the check you meant to keep;
- clone first — `inProcess` is asserted again at :137-138;
- accept that identity is surrendered: a transport substituting its OWN reading passes any tolerance.

## Production seam (separate, lower priority)

Making the clock injectable from outside needs THREE edges, not one: thread the observer at
`http-listener.ts:116`, publish the VALUE from `apps/daemon/src/index.ts` (line 91 is
`type SeamObserver` — type-only, so `DEFAULT_SEAM_OBSERVER` is unreachable outside the package),
and update the root-surface pin. `DEFAULT_SEAM_OBSERVER` greps to zero across `packages/*/src` —
it is daemon-internal, not a contracts re-export. The comment at `event-stream.ts:127-131` declines
the threading by name ("would ripple into the listener options type and every listener fixture"),
but it prices fixture cost only and predates this defect — quote it in any filing so a worker
finding it mid-step does not read it as a rail and stall.
