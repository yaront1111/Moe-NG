# Gotcha: pre-launch authority port throws must be contained

A green refusal matrix is insufficient if injected authority ports are only tested for returned refusals. In `launchClaude`, synchronous throws from duplicate resolution, commit validation, or grant consumption escaped the Promise even though later runtime/boundary throws were contained.

QA pattern: sweep every injected pre-launch port with a throwing implementation; assert the production entrypoint resolves (never rejects) to immutable `truthClass: UNKNOWN` with the exact stable reason code and refusing layer. Also assert the case count is nonzero/exact and register, lock, open, and spawn effects remain zero.