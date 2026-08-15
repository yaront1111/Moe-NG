# A client-set `Origin` header makes a server guard look covered while nothing tests it

`Origin` is a FORBIDDEN header name in the fetch spec. A browser silently DROPS
whatever the application sets and substitutes its own. Node's undici does NOT —
it sends the header verbatim.

So a client that sets `origin` in its own header object produces two different
worlds, and the guard is untested in both:

- BROWSER: the header never leaves. The browser's own Origin decides the outcome.
  The client's line is dead code.
- NODE (tests, scripts): the header arrives and satisfies the server guard by a
  route no browser can take. Every test passes. The guard is never exercised
  against what a real client actually sends.

Found in `packages/control-room-client/src/client-transport.ts` against
`apps/daemon/src/http/http-listener-guards.ts:127` (exact match required, absence
refused because `undefined !== origin`).

## How to tell it apart from a working setup

The tell is that the guard is green and has never been driven by the shipped client.
Grep the client for `origin` inside a headers object. If it is there, the
integration suite's Origin coverage is worth nothing.

## The fix, and the trap in the fix

Remove the header unconditionally. Then a Node caller sends NO Origin and every
request refuses — that is REAL, not a regression, and it is the moment the fix
gets undone by a careless hand. The two wrong repairs:

- put the header back behind an environment check (restores the illusion exactly);
- relax the server guard to admit a missing Origin (turns a coverage gap into a
  security hole).

Correct: a non-browser caller supplies Origin through its own fetch wrapper, the
way a browser does. In a test that is
`async (input, init) => fetch(input, {...init, headers: (h => (h.set("origin", o), h))(new Headers(init.headers))})`.

## The drill that proves the test is attached

Re-add the header to the client and run the absent-Origin arm. It MUST go red
(the no-Origin request starts succeeding with 200). If it stays green, the arm is
not testing the header — it is testing something else. Pair it with the opposite
drill on the guard (`if (false) return CODE`) so both directions kill.

Also: the ADMITTED arm is not redundant. Without it, "foreign refuses" and "absent
refuses" both pass against a guard that refuses EVERYTHING. And a positive arm
needs every LATER guard satisfied too — here the adapter's `x-moe-protocol-version`
header, absent from the test helper, so "admitted" first showed up as `REFUSED`
from the next layer down.
