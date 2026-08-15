# A `.js` bridge on a test-tier module is a FAILURE, not a convenience

`apps/daemon/src/runtime-entrypoint.test.ts` asserts the bridge set exactly:
every **runtime-tier** module has a `.js` bridge with byte-exact content
(`export * from "./<name>.ts";\n`), and every **test-tier** module has none.

Runtime tier is a **forward closure**, not a filename suffix: seed = `index.ts` plus any
module carrying its own `<name>.test.ts` sibling; tier = everything those reach through
`from "./x.js"` specifiers. Test files themselves are excluded from the scan, so a module
imported only BY a test never joins the tier.

`packages/control-room-client` has the same gate with a *different* rule — bridge unless
`.test.ts` / `-test-fixtures.ts` / `-test-helpers.ts` / the file imports vitest — and it
pins the excluded list **by name and reason**, so a new test file must be registered there
or the suite reddens.

**The trap I hit.** I wanted a spawned `node` process to load a fixture provider, so I
added bridges for `daemon-entry-fixtures.ts` and `http/http-test-fixtures.ts`. Both landed
in `unexpected` and reddened the gate. The fix is not a bridge — it is to prove the
positive path **in process** (vitest rewrites `./x.js` -> `x.ts`; Node does not) and give
the module a real `.test.ts` sibling if it genuinely belongs on the runtime surface.

Corollary: `apps/**` is NOT in the root `vitest.config.ts` include list
(`packages/**`, `tests/**` only), so app suites run via their own package config.

Related: [[task-task-318379eac8b54e688eadf7130b88f78e-handoff]]
