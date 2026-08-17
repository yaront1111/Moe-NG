import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS = 30_000;

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SRC_ROOT, "..");
const ENTRY_MODULE = resolve(SRC_ROOT, "index.ts");

/**
 * vitest rewrites a `./foo.js` specifier back to `foo.ts` and `tsc` never reads
 * the bridges at all, so a missing `.js` bridge is invisible to every other
 * suite in this package. These probes therefore run in a REAL child Node
 * process; in-process they would prove nothing.
 *
 * cwd is the package root so the bare specifier `@moe/daemon` resolves through
 * this package's own `exports` map by Node's self-reference rule — the exact
 * resolution an external dependent gets. A relative path would sidestep the
 * export map and test something weaker.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: PACKAGE_ROOT },
  );
  return JSON.parse(stdout) as unknown;
};

const REPORT_ROOT_NAMESPACE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/daemon");
  const keys = Object.keys(ns).filter((key) => key !== "default");
  report({
    outcome: "IMPORTED",
    hasNamedExports: keys.length > 0,
    undefinedBindings: keys.filter((key) => ns[key] === undefined),
    claimWork: typeof ns.claimWork,
    evaluateGraphPreviewRequestBytes: typeof ns.evaluateGraphPreviewRequestBytes,
    goalHandlersFrozen: Object.isFrozen(ns.GOAL_HANDLERS),
    readEventPage: typeof ns.readEventPage,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const REPORT_SUCCESSION_SURFACE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/daemon");
  report({
    outcome: "IMPORTED",
    anchorIncarnation: typeof ns.anchorIncarnation,
    codesFrozen: Object.isFrozen(ns.RECOVERY_SUCCESSION_ERROR_CODES),
    createRecoverySuccessionService: typeof ns.createRecoverySuccessionService,
    layer: ns.RECOVERY_SUCCESSION_LAYER,
    readAnchoredIncarnation: typeof ns.readAnchoredIncarnation,
    readSuccessionChain: typeof ns.readSuccessionChain,
    schemaVersion: ns.RECOVERY_SUCCESSION_SCHEMA_VERSION,
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

const REPORT_TEST_TIER_MODULE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  await import("./src/work/work-race-fixtures.js");
  report({ outcome: "IMPORTED", code: "NONE" });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE" });
}
`;

it("loads the @moe/daemon root namespace under Node with no undefined binding", async () => {
  // The existing package-root case in graph-preview-request.test.ts imports ONE
  // named export. This one takes the whole namespace, because an import cycle
  // yields a TDZ-undefined binding that imports cleanly and only fails at first
  // use, and cycles resolve differently per entry point. Reported by NAME so a
  // regression says which binding died. Asserting the child's exit code alone
  // would be vacuous: a process can exit 0 having imported nothing.
  expect(await probe(REPORT_ROOT_NAMESPACE)).toEqual({
    outcome: "IMPORTED",
    hasNamedExports: true,
    undefinedBindings: [],
    claimWork: "function",
    evaluateGraphPreviewRequestBytes: "function",
    goalHandlersFrozen: true,
    readEventPage: "function",
  });
}, RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS);

it("loads the recovery succession and anchor surface under plain Node", async () => {
  // DoD 6. Two NEW .js bridges ship with this surface, and vitest resolves a
  // `./foo.js` specifier back to `foo.ts` — so an absent or misnamed bridge is
  // invisible to every in-process suite and only a real child Node process can
  // see it. Values are reported, not just typeofs, so a binding that resolved
  // to the wrong module cannot pass.
  expect(await probe(REPORT_SUCCESSION_SURFACE)).toEqual({
    outcome: "IMPORTED",
    anchorIncarnation: "function",
    codesFrozen: true,
    createRecoverySuccessionService: "function",
    layer: "RECOVERY_SUCCESSION",
    readAnchoredIncarnation: "function",
    readSuccessionChain: "function",
    schemaVersion: "moe-recovery-succession/1",
  });
}, RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS);

it("still refuses an unbridged test-tier module with ERR_MODULE_NOT_FOUND", async () => {
  // Negative control, pinning the literal reason code rather than "it threw":
  // it proves test scaffolding was kept OFF the runtime surface and that the
  // probe above can still detect a failure instead of passing vacuously.
  expect(await probe(REPORT_TEST_TIER_MODULE)).toEqual({
    outcome: "FAILED",
    code: "ERR_MODULE_NOT_FOUND",
  });
}, RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS);

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const relativeImportTargets = (file: string): readonly string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]*)\.js"/g)].map((match) =>
    resolve(dirname(file), `${match[1]}.ts`),
  );

const testSiblingOf = (module: string): string => `${module.slice(0, -".ts".length)}.test.ts`;

/**
 * Runtime tier is a forward CLOSURE from published units, not a filename suffix.
 * `@moe/runner` can seed its tier from `-test-fixtures.ts` names; this package
 * cannot — `event-stream-fixtures.ts` and the whole `work-race-*` family are
 * scaffolding whose names match no such rule, while `http-adapter.ts` is
 * production code that today has no importer except its own test.
 *
 * So the seed is the package entry plus every module carrying its OWN
 * `<name>.test.ts` sibling — a module under direct test is a published unit —
 * and the tier is everything those reach. Scaffolding is what is left: imported
 * only BY tests, never reached FROM a published unit.
 */
const runtimeTierModules = (
  modules: readonly string[],
  present: ReadonlySet<string>,
): ReadonlySet<string> => {
  const tier = new Set(
    modules.filter((file) => file === ENTRY_MODULE || present.has(testSiblingOf(file))),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of [...tier]) {
      for (const target of relativeImportTargets(file)) {
        if (!present.has(target) || tier.has(target)) continue;
        tier.add(target);
        changed = true;
      }
    }
  }
  return tier;
};

const bridgeOf = (module: string): string => `${module.slice(0, -".ts".length)}.js`;

const expectedBridgeSource = (module: string): string =>
  `export * from "./${basename(module, ".ts")}.ts";\n`;

it("has an exact .js bridge for every runtime module and none for test-tier ones", () => {
  const files = walk(SRC_ROOT);
  const present = new Set(files);
  const modules = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const runtime = runtimeTierModules(modules, present);
  const testTier = modules.filter((file) => !runtime.has(file));

  // A sweep that silently generates zero cases passes while testing nothing,
  // and the two judgement calls are pinned by name so a future filename-based
  // rewrite of the rule cannot flip them back without reddening this case.
  expect(runtime.size).toBeGreaterThan(0);
  expect(testTier.length).toBeGreaterThan(0);
  expect(runtime.has(resolve(SRC_ROOT, "http/http-adapter.ts"))).toBe(true);
  expect(runtime.has(resolve(SRC_ROOT, "work/work-race-fixtures.ts"))).toBe(false);

  const bridges = new Set(files.filter((file) => file.endsWith(".js")));
  const missing = [...runtime].filter((file) => !bridges.has(bridgeOf(file)));
  const unexpected = [...bridges].filter((bridge) => {
    const module = `${bridge.slice(0, -".js".length)}.ts`;
    return !present.has(module) || !runtime.has(module);
  });
  const wrongContent = [...runtime].filter(
    (file) =>
      bridges.has(bridgeOf(file)) &&
      readFileSync(bridgeOf(file), "utf8") !== expectedBridgeSource(file),
  );

  // Report by NAME so a regression says which module, not merely a count.
  expect({
    missing: missing.map((file) => relative(SRC_ROOT, file)),
    unexpected: unexpected.map((file) => relative(SRC_ROOT, file)),
    wrongContent: wrongContent.map((file) => relative(SRC_ROOT, file)),
  }).toEqual({ missing: [], unexpected: [], wrongContent: [] });
}, RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS);

/**
 * The Foundation ingress surface, resolved and EXERCISED in a real child Node
 * process. Every name is listed with its expected typeof so a curated symbol
 * that stopped being published is reported BY NAME rather than as a count, and
 * the count itself is pinned so a probe that silently resolved nothing — which
 * would exit 0 — cannot pass.
 *
 * Only decode and read paths are invoked. Nothing here writes, spawns, launches
 * or opens a store: `runReviewCommand` and `decodeReviewRequestBytes` both refuse
 * at ingress before any durable read, so a null store is never dereferenced, and
 * `qualifyGoalClosure` is handed a store whose only method throws so it takes its
 * fail-closed branch. `deriveRecipeAggregateId` is a pure string derivation.
 */
const REPORT_FOUNDATION_SURFACE = `
const report = (value) => process.stdout.write(JSON.stringify(value));
const ENTRYPOINTS = [
  ["CONTINUATION_COMMAND_KIND", "string"], ["CONTINUATION_PAYLOAD_KEYS", "object"],
  ["DAEMON_FOUNDATION_ATTEMPT", "string"], ["DELTA_CLASSIFICATIONS", "object"],
  ["FOUNDATION_ATTEMPT_CODES", "object"], ["FOUNDATION_ATTEMPT_RECORD_VERSION", "string"],
  ["FOUNDATION_ATTEMPT_REQUEST_KEYS", "object"], ["FOUNDATION_ATTEMPT_SCHEMA_VERSION", "string"],
  ["FOUNDATION_DISPATCH_COMMAND_KIND", "string"], ["FOUNDATION_RESERVATION_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_CODES", "object"], ["FOUNDATION_VERIFICATION_COMMAND_KIND", "string"],
  ["FOUNDATION_VERIFICATION_LAYERS", "object"],
  ["FOUNDATION_VERIFICATION_RECEIPT_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_RECIPE_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_REFUSAL_SOURCES", "object"],
  ["FOUNDATION_VERIFICATION_REQUEST_KEYS", "object"],
  ["FOUNDATION_VERIFICATION_SCHEMA_VERSION", "string"],
  ["FOUNDATION_VERIFICATION_VERDICTS", "object"], ["GOAL_CLOSURE_WITNESS_VERSION", "string"],
  ["GOAL_PREREQUISITE_LAYER", "string"], ["GOAL_PREREQUISITE_REFUSAL_CODES", "object"],
  ["RESTART_RECONCILIATION_COMMAND_KIND", "string"],
  ["RESTART_RECONCILIATION_SCHEMA_VERSION", "string"],
  ["RESTART_RECORD_CLASSIFICATIONS", "object"], ["REVIEW_COMMAND_KINDS", "object"],
  ["REVIEW_INGRESS_REFUSAL_CODES", "object"], ["REVIEW_PREREQUISITE_REFUSAL_CODES", "object"],
  ["REVIEW_REFUSED_BY", "object"], ["REVIEW_REQUEST_KEYS", "object"],
  ["REVIEW_SCHEMA_VERSION", "string"], ["RUNNER_WORKSPACE_LAYER", "string"],
  ["SCHEDULER_GRAPH_LAYER", "string"], ["coordinationPresentationDigest", "function"],
  ["createCoordinationAdapter", "function"], ["createFoundationAttemptService", "function"],
  ["createFoundationVerificationService", "function"], ["decodeReviewRequestBytes", "function"],
  ["deriveRecipeAggregateId", "function"], ["deriveVerificationAggregateId", "function"],
  ["qualifyGoalClosure", "function"], ["readFoundationAttemptRecord", "function"],
  ["readReconciliationRecords", "function"], ["readReviewLedger", "function"],
  ["reconcileOnRestart", "function"], ["runContinuationCommand", "function"],
  ["runReviewCommand", "function"],
];
try {
  const ns = await import("@moe/daemon");
  const unresolved = ENTRYPOINTS
    .filter(([name, kind]) => typeof ns[name] !== kind)
    .map(([name]) => name);
  const malformed = new TextEncoder().encode("{");
  const decoded = ns.decodeReviewRequestBytes(malformed);
  const command = ns.runReviewCommand(null, malformed);
  const closure = ns.qualifyGoalClosure(
    { readEvents() { throw new Error("store unavailable"); } },
    "project-1",
    "goal-1",
  );
  report({
    outcome: "IMPORTED",
    resolved: ENTRYPOINTS.length - unresolved.length,
    unresolved,
    reviewDecode: { code: decoded.code, refusedBy: decoded.refusedBy },
    reviewCommand: {
      authority: command.authority, code: command.code, refusedBy: command.refusedBy,
    },
    goalClosure: { code: closure.code, layer: closure.layer },
    frozen: [
      Object.isFrozen(ns.FOUNDATION_ATTEMPT_CODES),
      Object.isFrozen(ns.FOUNDATION_VERIFICATION_VERDICTS),
      Object.isFrozen(ns.REVIEW_COMMAND_KINDS),
    ],
    recipeAggregateId: ns.deriveRecipeAggregateId("verify-1"),
    schemaVersions: [
      ns.REVIEW_SCHEMA_VERSION, ns.RESTART_RECONCILIATION_SCHEMA_VERSION,
      ns.FOUNDATION_ATTEMPT_SCHEMA_VERSION, ns.FOUNDATION_VERIFICATION_SCHEMA_VERSION,
      ns.GOAL_CLOSURE_WITNESS_VERSION,
    ],
  });
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE", message: error.message });
}
`;

it("resolves and exercises the Foundation ingress surface under plain Node", async () => {
  // DoD 3. Vitest rewrites a `./foo.js` specifier back to `foo.ts`, so the two
  // NEW modules this task ships (foundation/foundation-surface.ts and
  // graph-preview-request.ts) would load in-suite even with no `.js` bridge and
  // fail for a real consumer. Only a child Node process resolving the bare
  // `@moe/daemon` root through the real `.js` graph can see that.
  //
  // `resolved: 47` is the anti-vacuity pin: a probe that resolved nothing exits
  // 0 and would otherwise read as a pass. `unresolved: []` names the casualty
  // instead of merely lowering the count.
  expect(await probe(REPORT_FOUNDATION_SURFACE)).toEqual({
    outcome: "IMPORTED",
    resolved: 47,
    unresolved: [],
    // Reason codes AND refusing layers, from production, through the published
    // root — not "it refused".
    reviewDecode: { code: "REVIEW_INPUT_REJECTED", refusedBy: "DAEMON_INGRESS" },
    reviewCommand: {
      authority: "NONE", code: "REVIEW_INPUT_REJECTED", refusedBy: "DAEMON_INGRESS",
    },
    goalClosure: {
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", layer: "DAEMON_PREREQUISITE",
    },
    frozen: [true, true, true],
    recipeAggregateId: "foundation-verify-recipe:verify-1",
    // Values, not typeofs: a binding that resolved to the wrong module cannot pass.
    schemaVersions: [
      "moe-review-command/1",
      "moe-restart-reconciliation/2",
      "moe-foundation-attempt/1",
      "moe-foundation-verification/1",
      "moe-goal-closure-witness/1",
    ],
  });
}, RUNTIME_FILESYSTEM_PROBE_TIMEOUT_MS);
