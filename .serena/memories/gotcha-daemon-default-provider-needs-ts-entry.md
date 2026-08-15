# Daemon default providers are loaded through the .ts source entry, not the exact .js bridge

Found on task-2ff368fe, 2026-08-12.

`apps/daemon/src/runtime-entrypoint.test.ts` enforces every runtime bridge byte-exactly as:

`export * from "./<name>.ts";\n`

ES `export *` deliberately does NOT re-export a default. Adding `export { default } ...` makes the actual provider available from `daemon-store-dependencies.js`, but the bridge audit correctly reddens it as `wrongContent: ["daemon-store-dependencies.ts"]`.

The source-run daemon already executes TypeScript under Node 24 strip-types. For a dependency module whose DEFAULT export is the entry contract, pass the `.ts` path to `--dependencies` and test/load `daemon-store-dependencies.ts` directly. Keep the sibling `.js` bridge exact for named relative imports and the runtime closure; do not turn it into a second entry barrel.

A Vitest test that statically default-imports the `.js` bridge receives `undefined`. To exercise the actual source entry without TS5097, construct the dynamic specifier (for example `"../daemon-store-dependencies." + "ts"`) and assert the default provider shape. A plain Node probe against the same `.ts` path is the runtime proof.