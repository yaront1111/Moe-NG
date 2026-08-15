# Gotcha: object-literal field ordering as a security control is invisible to tests

Pattern found in `packages/mcp/src/stdio/stdio-server.ts` (task-c9a9bf3cb2, QA-rejected
reopen 1). Applies to EVERY MCP transport adapter in this repo — the Streamable HTTP
sibling will reproduce it verbatim if nobody says so.

## The shape

An adapter assembles a runtime envelope from client-supplied tool arguments plus fields
only the adapter may set:

```ts
serialize({
  ...args,                                   // client-controlled
  commandKind: kind,                         // adapter-supplied, MUST win
  requestDigest: payloadDigest(args["payload"]),
  schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
  sessionCredential: credential,
})
```

Correctness rests entirely on *spread first, adapter fields last*. Swap two lines and the
client wins. There is no type error, no lint, and — unless you write for it — no test.

## Why the obvious tests do not cover it

1. **The generated `inputSchema` is not enforcement.** The low-level SDK `Server` does not
   validate `params.arguments` against a tool's advertised `inputSchema`;
   `CallToolRequestSchema` types `arguments` as a passthrough record. So
   `additionalProperties: false` is advice to a well-behaved client, and a schema test
   asserting `commandKind` is absent from `properties` proves only what is **advertised**,
   never what a hostile client can **send**. Do not confuse the two.
2. **A partial smuggle test gives false confidence.** The task tested that a client-supplied
   `sessionCredential` and `requestDigest` are overwritten, and the handoff memory recorded
   the property as "tested". It covered 2 of 4 command fields and 0 of 3 query fields.

## The escalation the gap hides

`commandKind` is the worst field to leave unlocked, because the authenticated kind and the
executed kind come from different places:

```
callTool      -> entry resolved from the TOOL LABEL      -> entry.kind = "goal.create"
authenticate(credential, entry.kind)                     -> capability checked for goal.create
dispatch bytes carry envelope commandKind                -> "goal.close" if the client won
isCommandKind("goal.close") passes                       -> daemon executes the wrong command
```

Read-scoped capability, write-scoped execution. Same for `queryKind` on the read surface.

## Mutation recipe that finds it (run this, do not trust green)

Mutate **one field at a time**, not the whole block. Moving all four adapter fields above
`...args` kills a test and reads as "covered"; moving only `commandKind` survives with
48/48 green. Per-field granularity is what separates a real lock from a neighbouring one.

```
perl -0pi -e 's/      \.\.\.args,\n      commandKind: kind,/      commandKind: kind,\n      ...args,/' <file>
pnpm --filter @moe/mcp test
git checkout -- <file>
```

## The test that actually locks it

Assert on the **decoded dispatched envelope**, not on the schema, and iterate the exported
`ADAPTER_SUPPLIED_COMMAND_FIELDS` / `ADAPTER_SUPPLIED_QUERY_FIELDS` arrays rather than
hand-listing fields — a field added to those arrays later then gets covered automatically
instead of silently uncovered. Send a *different valid* kind (not garbage), so the decoder's
vocabulary check cannot mask the missing override.

See `mem:task-task-c9a9bf3cb2a046a68ee99efa5b296f8c-qa-verdict`,
`mem:gotcha-mcp-sdk-1.30-repo-toolchain`.
