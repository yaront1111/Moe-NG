# Root bare imports need a real root dependency edge

In this pnpm workspace, package root exports do not make a bare specifier loadable from the repository root. The root consumer must declare the producer in `package.json` and have matching links in the `.` importer of `pnpm-lock.yaml`; otherwise plain Node from the root reports `ERR_MODULE_NOT_FOUND` even when package-local tests pass.

For a trustworthy edge:
1. Verify the public symbols exist at the producer root.
2. Add `workspace:*` dependencies and generate the lock with the pinned workspace pnpm.
3. Materialize links (lock-only is insufficient).
4. Typecheck an in-repo bare-import probe.
5. Run a plain-Node probe from the actual consumer root; Vitest transforms or a producer-package cwd can mask a missing root edge.
6. Trap-clean/delete all probes and require nonzero test counts.