# QA handoff: task-d20ffd0775b4420bb2318c79019b4127

Approved DONE on 2026-08-16 by qa-7d1f37bd.

Reviewed commit `77e037c` across the 9 human-authorized store paths. Current HEAD owned bytes matched the task commit; `git diff --check` was clean. Production line counts: store-contracts 297, store-internals 132, sqlite-schema-manifest 250, sqlite-schema-migration 197 (all below hard 400 cap).

Verified schema v5 and exact frozen v4 migration source, one generic `domain_events_event_type_position(event_type, global_position)` index, additive v4->v5 behavior, ordered v1-v4 migration, exact stable refusal codes, query-plan use with no scan/temp sort, and a nonempty production-surface fixture preserving all durable rows/blobs/positions/sequences/project/recovery state across migration and a second reopen.

Fresh committed-HEAD ext4 snapshot gate (workspace dependency links and the live ignored release broker artifact rehydrated): `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test && pnpm verify:store && pnpm typecheck && pnpm test` EXIT 0. Store: 42 files / 504 tests twice. Repo: 274 files, 6511 passed + 3 skipped (6514 total). All typechecks passed.

Independent mutation drill reversed the production index columns. Named query-plan test failed exactly on `[global_position,event_type]` versus `[event_type,global_position]`; file restored byte-exact with SHA-256 `c9c41413ae78f835a739a4e3a13d8d7603508e60415be90c28a84965c678b572`.
