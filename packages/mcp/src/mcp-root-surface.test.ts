import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import * as rootSurface from "@moe/mcp";
import type {
  HttpAdapterOptions,
  HttpAuthOutcome,
  HttpDispatchPort,
  HttpMcpAdapter,
  HttpSessionPort,
} from "@moe/mcp";

/**
 * Pins the PUBLISHED surface of `@moe/mcp` — the one thing a consumer can reach, since
 * `package.json` maps `exports` to the single entry `"." -> "./src/index.ts"` and no subpath.
 *
 * Every list below is HAND-WRITTEN, transcribed by reading `index.ts`, never derived from the
 * module under test. A list built from `Object.keys(rootSurface)` asserts that the module
 * equals itself: drop an export and it still passes. The counts are pinned separately so a
 * silently emptied list cannot pass either.
 *
 * Only ONE of the six names this change publishes is a runtime value. The other five are
 * types, leave no trace in a namespace object, and are proved reachable by annotation below —
 * putting them in a runtime list would be a test that cannot pass.
 */

/** Published before this change. Listed here so a shadowing HTTP re-export fails. */
const PUBLISHED_STDIO_VALUES: readonly string[] = [
  "ADAPTER_SUPPLIED_COMMAND_FIELDS",
  "ADAPTER_SUPPLIED_QUERY_FIELDS",
  "MOE_MCP_PACKAGE_VERSION",
  "MOE_SESSION_CREDENTIAL_ENV",
  "STDIO_TOOL_ENTRIES",
  "STDIO_TOOL_INDEX",
  "STDIO_TOOL_LABEL_PATTERN",
  "connectStdioTransport",
  "createStdioMcpServer",
  "decodeAndDispatch",
  "generateStdioToolEntries",
  "readBootstrapCredential",
  "toolLabelForKind",
];

/**
 * The HTTP runtime values the root publishes. `createHttpMcpAdapter` is the adapter factory;
 * the other three are the shutdown-failure vocabulary a host needs to tell a PARTIAL shutdown
 * from a clean one — the code list, the layer that raised it, and the error carrying both.
 * Transcribed by reading `index.ts`, and pinned by count below like every other list here.
 */
const PUBLISHED_HTTP_VALUES: readonly string[] = [
  "HTTP_SHUTDOWN_LAYER",
  "HTTP_SHUTDOWN_REFUSAL_CODES",
  "HttpShutdownError",
  "createHttpMcpAdapter",
];

/**
 * Runtime values that `http-server.ts` exports and the root deliberately does NOT. They are the
 * negative control: they turn "the surface is no wider than needed" into an assertion, and they
 * are what would appear if the block were ever loosened to `export *`.
 */
const WITHHELD_HTTP_VALUES: readonly string[] = [
  "HTTP_LISTED_TOOLS",
  "LOOPBACK_HOSTNAMES",
  "MCP_PROTOCOL_VERSION_HEADER",
];

const namespaceEntries = rootSurface as unknown as Readonly<Record<string, unknown>>;

const publishedNames = (): readonly string[] =>
  Object.keys(rootSurface)
    .filter((key) => key !== "default")
    .sort();

it("publishes exactly the hand-written stdio and HTTP runtime names", () => {
  // Pinned counts first: an accidentally emptied expectation would otherwise make the
  // set comparison below trivially satisfiable from the other side.
  expect(PUBLISHED_STDIO_VALUES).toHaveLength(13);
  expect(PUBLISHED_HTTP_VALUES).toHaveLength(4);

  // Set equality, so this fails on a DROPPED name and on an ADDED one alike. Both surfaces
  // are asserted in this single expectation: an HTTP re-export that shadowed or displaced a
  // stdio name reddens here rather than passing as "the HTTP names are all present".
  expect(publishedNames()).toEqual([...PUBLISHED_STDIO_VALUES, ...PUBLISHED_HTTP_VALUES].sort());
});

it("leaves every published name bound to a defined value", () => {
  // A name can be present and still be `undefined` — an import cycle yields exactly that, and
  // it imports cleanly, failing only at first use. Presence alone is not reachability.
  expect(
    [...PUBLISHED_STDIO_VALUES, ...PUBLISHED_HTTP_VALUES].filter(
      (name) => namespaceEntries[name] === undefined,
    ),
  ).toEqual([]);
  expect(typeof rootSurface.createHttpMcpAdapter).toBe("function");
});

it("withholds the http-server runtime values the root does not name", () => {
  expect(WITHHELD_HTTP_VALUES).toHaveLength(3);
  expect(WITHHELD_HTTP_VALUES.filter((name) => name in namespaceEntries)).toEqual([]);
});

/**
 * Everything above runs under vitest, which rewrites a `./foo.js` specifier back to `foo.ts`.
 * Real Node does not, and `--experimental-strip-types` strips types without adding TypeScript's
 * `.js` -> `.ts` resolution — so a green vitest run cannot show the PUBLISHED root loads. The
 * probe below therefore runs in a real child Node process, exactly as
 * `mcp-runtime-entrypoint.test.ts` does, and imports the BARE specifier `@moe/mcp`: cwd is the
 * package root, so Node resolves it through this package's own `exports` map by the
 * self-reference rule — the resolution a consumer gets. A relative path would sidestep the map.
 */
const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_KILL_MS = 20_000;

const REPORT_HTTP_SURFACE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/mcp");
  report({
    outcome: "IMPORTED",
    createHttpMcpAdapter: typeof ns.createHttpMcpAdapter,
    createStdioMcpServer: typeof ns.createStdioMcpServer,
    withheld: ["HTTP_LISTED_TOOLS", "LOOPBACK_HOSTNAMES", "MCP_PROTOCOL_VERSION_HEADER"]
      .filter((name) => name in ns),
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE", specifier: error.url ?? "NO_URL" });
}
`;

it("loads the published HTTP surface from the bare specifier in a real Node process", async () => {
  // The child is killed on timeout rather than left to outlive the run: vitest's own test
  // timeout fails the assertion but would not reap the process, and a hung child reads as
  // "no failure". `outcome` is asserted too, so a resolution failure reports its reason code
  // and specifier instead of collapsing into a bare undefined typeof.
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", REPORT_HTTP_SURFACE],
    { cwd: PACKAGE_ROOT, timeout: CHILD_KILL_MS },
  );

  expect(JSON.parse(stdout) as unknown).toEqual({
    outcome: "IMPORTED",
    createHttpMcpAdapter: "function",
    createStdioMcpServer: "function",
    withheld: [],
  });
}, CHILD_TIMEOUT_MS);

/**
 * DoD 4. A type-only export leaves no runtime trace, so every assertion above is blind to the
 * five published types: the namespace has no key for them and the Node probe cannot see them.
 * Reachability is proved instead by ANNOTATING a value with each type through the BARE
 * specifier and letting tsc check it — a relative import would compile while proving nothing
 * about the published surface, the same vacuous shape the hand-written list rules out.
 *
 * TSC IS THE ASSERTION HERE. `pnpm --filter @moe/mcp typecheck` going red is the failure
 * signal; the runtime expectation at the bottom only keeps these bindings live under
 * `noUnusedLocals` and is not what proves the item.
 *
 * Two of the five are pinned harder than mere existence, at no runtime cost:
 *   - `adapterOptions` is a real object literal, so the published `HttpDispatchPort` and
 *     `HttpSessionPort` must be exactly the types the published options expect. Republishing
 *     a lookalike from elsewhere would fail here.
 *   - `adapter` is annotated from `ReturnType<typeof createHttpMcpAdapter>`, so the published
 *     `HttpMcpAdapter` must be what the published factory actually returns.
 * No adapter or session is constructed: this item is reachability, not behaviour.
 */
const dispatchPort: HttpDispatchPort = null as unknown as HttpDispatchPort;
const sessionPort: HttpSessionPort = null as unknown as HttpSessionPort;
const adapterOptions: HttpAdapterOptions = { dispatchPort, sessionPort };
const adapter: HttpMcpAdapter = null as unknown as ReturnType<
  typeof rootSurface.createHttpMcpAdapter
>;
const authOutcome: HttpAuthOutcome = { ok: true };

it("reaches all five published types through the bare specifier", () => {
  // Runtime cannot see a type. This keeps the five annotated bindings live and records that
  // exactly five were declared; the proof itself is the typecheck leg of the gate.
  expect([dispatchPort, sessionPort, adapterOptions, adapter, authOutcome]).toHaveLength(5);
  expect(authOutcome).toEqual({ ok: true });
});
