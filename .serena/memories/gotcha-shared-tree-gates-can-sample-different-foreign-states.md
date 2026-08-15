# Sequential gates do not imply one shared-tree snapshot

In the single shared checkout, another worker can edit or commit between legs of one foreground verification sequence. On task-8f84c56d88504f80aa2fefdf69f093bd, `pnpm typecheck` passed, then foreign orchestrator tests appeared before `verify:foundation` and `verify:store`, causing both later legs to fail typecheck. A foreign whole-tree commit also swept the task's owned bytes between focused GREEN and final verification.

Treat each leg as its own timestamped observation:
- capture its exact exit and failing paths separately;
- re-check HEAD and owned-path hashes/status before and after the sequence;
- never describe several legs as one atomic snapshot;
- never reset/amend/recommit when a foreign whole-tree commit captured the owned bytes;
- run the plan's exact final command fresh after the broad observations, because earlier typecheck output may already be stale.