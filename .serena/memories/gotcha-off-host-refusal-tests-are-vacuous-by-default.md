# A refusal test can be answered by the WRONG gate and still look right

Found by mutation drill on task-f01ef545 (Linux platform boundary), 2026-08-09. Generalises to any layered classifier in this repo.

## The failure
`observeLinuxPlatform` short-circuits when `host.os !== "linux"`. The obvious test: declare a darwin host, assert all seven boundaries refuse with `PLATFORM_HOST_MISMATCH` at `PLATFORM_LINUX`.

**Delete the short-circuit entirely and that test stays GREEN.** The fixture declared darwin but left every *envelope* host saying `"linux"`, so the per-boundary "envelope host disagrees with declared host" gate refused each boundary — with the **same code at the same layer**. A second refusal layer answered first and the assertion silently detached from its subject.

Pinning code AND layer (epic rail 6) was necessary and **still not sufficient**, because both gates legitimately report the same pair.

## The fix that works
Build a fixture where **every other gate is satisfiable**, so only the gate under test can refuse. Here: `coherentHostInput(os)` makes the declared host, all seven envelope hosts, and both provider `platformIdentity` records agree on the non-Linux OS. Without the short-circuit that input classifies **PROVEN**; with it, all seven refuse. Now the drill goes red.

## Rule of thumb
When two gates can emit the same reason code, a test naming that code proves nothing about which gate ran. Either:
1. construct an input only the gate under test can reject (preferred — it is a behavioural assertion), or
2. give the gates distinguishable codes.

Never settle for "it refused". The only way to know is to **mutate the gate and watch the test go red** — a green suite cannot tell you.

## Second instance, same task
`classifyLinuxBoundary` hardened `boundary` and `envelope` against hostile input but trusted `context`, so `{host: null, ...}` THREW out of a published root export instead of failing closed. Two of three parameters defended is worse than none: it reads as defended. When an entry point takes `unknown` for hostile-input reasons, **every** caller-supplied parameter needs the same treatment.
