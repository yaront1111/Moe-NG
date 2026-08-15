# OS launch lock must precede Windows boundary open

`openWindowsProcessBoundary` starts the broker, and the broker can create/resume the provider. Therefore a supervisor `registerLaunchLock` call after `boundary.started` is only post-start bookkeeping; `supervisor/launch-lock.ts` is deliberately pure and explicitly touches no OS.

Safe launcher order: validate prior/claim through the real supervisor register surface, acquire a real OS-exclusive lease, then call `openWindowsProcessBoundary`. Keep the lease held through process close/stream settlement/observation and release it before returning. Assert every prior/malformed/contention refusal has exact code/layer plus zero boundary open, and add a concurrent production-lock test proving only one delivery opens.

For Node without a native named-mutex binding, atomic `fs.open(path, "wx")` on a digest-derived local temp path is a real OS-exclusive fail-closed sentinel. Keep its handle/file until cleanup; map EEXIST to `LAUNCH_LOCK_IDENTITY_CONFLICT` / `LAUNCH_LOCK`, other acquire/release ambiguity to a stable UNKNOWN code.