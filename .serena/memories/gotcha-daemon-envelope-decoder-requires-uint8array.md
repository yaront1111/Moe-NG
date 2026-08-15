# `decodeRuntimeCommandEnvelopeBytes` refuses a string, silently

`packages/contracts/src/bounded-json.ts:48` `snapshotBytes`:

```ts
if (types.isProxy(input) || !types.isUint8Array(input)) {
  return failure("JSON_INPUT_TYPE_INVALID");
}
```

Everything above it — `decodeBoundedJsonBytes`, `decodeBody`,
`decodeRuntimeCommandEnvelopeBytes`, `handleCommandRequest` — takes `unknown`. So handing
the adapter `body` as a **string** typechecks, runs, and refuses every well-formed command
at the DECODE stage. The socket answers, the status is a plausible 4xx, and nothing in a
transport-layer unit suite notices.

**How it was caught:** only by a round trip asserting the daemon returned
`outcome: "ACCEPTED"`. A test that asserted "a response arrived" or "status < 500" passes
with this bug live.

**Rule:** anything feeding the runtime envelope decoder must hand over a real
`Uint8Array` — `Uint8Array.from(Buffer.concat(chunks))`, not `.toString("utf8")`. Pin it
with a mutation drill: revert to a string and confirm the integration case reddens.

Related: [[task-task-318379eac8b54e688eadf7130b88f78e-handoff]]
