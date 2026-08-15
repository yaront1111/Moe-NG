# task-c690a7a0 cross-host bare-root edge handoff (2026-08-15)

Fresh audit at HEAD `18f09644026dfd70778eb7baf1f6b4499b1dbfb7`:
- Hard prerequisite `task-f6ef0a45f52c45c7bb54f250170aa223` is still PLANNING and held by another architect, not DONE.
- Relevant `package.json`, `pnpm-lock.yaml`, daemon root, and cross-host paths were clean at measurement.
- From repository root, bare imports of both `@moe/runner` and `@moe/daemon` fail `ERR_MODULE_NOT_FOUND`, as expected before this task.
- Because f6ef has not published `collectDoctorVersionReport`, planning the durable bare-root call site now would name an absent surface.

Reported BLOCKED with `needsFrom=task-f6ef0a45f52c45c7bb54f250170aa223`. Resume only after f6ef is DONE; re-probe the callable doctor collector from bare `@moe/daemon`, ensure package/lock paths remain clean, then plan the three owned files exactly. Do not deep-import, use tsconfig paths/project references, or substitute a cwd subprocess trick.