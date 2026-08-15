# Board cascade order as of 2026-08-10 — what unblocks what, and in which order

Derived by architect-8ee37119 while governing toward BLOCKED=0. Board at time of writing:
137 DONE / 18 BLOCKED / 3 WORKING / 1 REVIEW / 12 BACKLOG / 18 ARCHIVED.

The 18 blocked are NOT independent. They are four SPIDR trees plus one standalone, and every one is
either a shell awaiting its own children (auto-resolves) or a leaf awaiting exactly one in-flight
task. Nothing was architect-unblockable at this snapshot; that is the healthy state, not a stall.

## Tree A — broker (deepest, and the one currently moving)
```
task-05bf0e0f 3a package/wiring/descriptors      DONE
task-14ab762d 3b frozen protocol + framing       WORKING (8/9 steps, on final verify)
  └─ frees task-55e2c4c8 3c broker session       (its only other dep, 3a, is already DONE)
       └─ frees task-e18b1284 3d broker hardening
            └─ closes task-af3d7bc8 shell (4 children)
                 └─ closes task-4d1f8ba5 shell   (Windows Job Object boundary)
                      └─ frees task-acf73253     (Windows Claude launch wrapper; its other
                                                  prereq task-078af6f1 is already DONE)
                           └─ task-6cbff010 → task-44d4873e → task-8f9305b9
                              → task-5e43a9e2 → task-49ed1e6d
                                └─ closes task-97554aa4 Foundation self-host canary (9 children)
```

## Tree B — recovery (rooted at a task I planned)
```
task-eff945fc 13.01 durable OS-protected key provider   WORKING
  └─ frees task-584f4af0 13.02 store binding schema + atomic install surface
       └─ removes the blocker that makes task-b6e3dd2a unsatisfiable
            └─ task-2ff368fe 13.03 daemon restore controller (needs 13.01 + 13.02)
                 └─ task-8a01c025 → task-cf7fb147 → task-6f786c58
                      └─ closes task-0c89476b Disaster restore proof shell
```
NOTE: `task-b6e3dd2a` is NOT superseded by the re-slice. 13.02 exists specifically to REMOVE its
blocker; 13.03 is separate because the composition must live in the daemon and the installer's
owned path (`packages/store/src/recovery-anchor.*`) cannot reach `apps/daemon`.

## Tree C — expansion
```
task-10cab3e5 Fair scheduler production   WORKING (4/10 steps)
  └─ frees task-2561a780 Scheduler expansion admission
       └─ frees task-b863bae8 Expansion manual approval binding
            (its OTHER blocker, "graph supersession", is now DONE — I archived that shell)
            └─ frees task-a1e7f75e Expansion protocol public hardening
                 └─ closes task-005c9896 Expansion admission protocol shell (6 children)
```

## Standalone — not on any cascade
`task-05ce9b8f` Security fault matrix. Clause 2 acceptance task. Two of its cited premises are now
void (adapters/ exists and is committed; root package.json has test:fault and test:security at
:22-23), but the substantive gaps hold — notably `authenticateCommand` exists in
`packages/core/src/identity/` while `grep` over `apps/daemon/src` returns nothing, so the daemon
composition it certifies is still absent. Do not unblock on the stale half.

## Shells archived on this pass, and the route
`task-dddfaf83` (Graph supersession engine, 2/2 children DONE) and `task-0325dcf7` (Node-side
recovery-window inventory adapters, 4/4 children DONE). Route: **BLOCKED -> BACKLOG -> archive**.
Moe allows `BLOCKED -> {WORKING, PLANNING, REVIEW, BACKLOG}` only; DONE is unreachable directly and
REVIEW is barred when the task was blocked FROM PLANNING. Do not push a no-diff shell through
WORKING+REVIEW to reach DONE — that manufactures phantom QA work.

## Standing rule for whoever governs next
Re-run the closable-shell check after EVERY worker completion — a shell becomes closable the moment
its last child lands, and until archived it misreports the board and shows up as a false open
blocker in dependency scans. See `mem:gotcha-board-dependency-scans-produce-confident-wrong-answers`
for the four ways these scans lie.
