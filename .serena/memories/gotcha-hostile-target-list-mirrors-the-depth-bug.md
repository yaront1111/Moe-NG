# A hand-listed hostile-target array reproduces the bug it is meant to find

Pattern seen on task-311adb23 (three QA rejections, same property each time): a hardening test builds its
matrix as `TARGETS × POISONS`, where TARGETS is a hand-written list of node paths. The production parser had
an exact-snapshot boundary applied at *some* depths; the TARGETS list stopped at exactly the same depths.
Each rejection closed the one depth QA reported, and the next depth stayed invisible — because no fixture in
the file could reach it.

Two independent silencers, both present at once:
1. TARGETS listed only depth 0-2 paths (`[]`, `lease`, `slot`, `budget`, `effect`, `effect.command`) — no
   array-element path existed.
2. The valid fixture had `liveClaims: []`, so even adding an element path would have poisoned nothing.

**Rule:** when a test sweeps a graph, ENUMERATE the paths by walking the fixture, then assert the discovered
set against a hand-written sorted list (not against the walk's own output — `mem:qa-generated-table-cannot-police-its-own-generator`).
Name the deepest paths explicitly. And check the fixture actually contains a node at every depth the walk
claims to cover; an empty collection makes a whole depth silently uncoverable.

**Corollary — classify poisons before sweeping them everywhere.** Structural faults (accessor, symbol key,
custom prototype, function value, any proxy) are refused by the snapshot at any depth with one stable code.
A merely *content* fault (an extra own string key) is decided by whichever upstream validator receives the
data, so at depth it answers with a different code and a non-null upstream code. Sweeping content poisons
blindly asserts the wrong tuple and reads as broader coverage.

The assertion that would have caught all three depths at once: instrument EVERY node of the input graph with
counting accessors and assert the counter is exactly zero for refused inputs. A matrix is a list of the
depths you thought of; the counter finds the one you did not.
