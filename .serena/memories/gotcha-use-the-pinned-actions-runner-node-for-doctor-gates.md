# Gotcha: doctor self-pin gates require Node 24.16.0

This repo's doctor test expects the live Node runtime to satisfy `.node-version` exactly. `/home/sysadmin/actions-runner/externals.2.336.0/node24/bin/node` is v24.18.0 and makes `doctor-version.node.test.ts` report NODE_RUNTIME MISMATCHED. A pinned Linux v24.16.0 is available at `/home/sysadmin/actions-runner/externals.2.335.1/node24/bin/node`.

When using that Node through pnpm, prepend its directory to PATH as well as invoking pnpm with it; generated `node_modules/.bin/*` shims call `node` from PATH. Without the PATH change, the apparent direct Node choice does not control Vitest's runtime.