import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { activateEffect, type ActivationCommit } from "../supervisor/effect-activation.js";
import type { ActivationGrant } from "../supervisor/effect-kernel.js";
import {
  makeActivationRequest,
  makeAttempt,
  makeClaim,
  makeGrant,
  makeIntent,
} from "../supervisor/effect-test-fixtures.js";
import { buildProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import type { ProviderRuntimeObservation } from "../providers/claude/claude-observation.js";
import { buildInputManifest } from "../workspace/workspace-manifest.js";
import type { WorkspaceInputManifest } from "../workspace/workspace-contract.js";
import { buildVerificationRecipe } from "./verification-recipe.js";
import type { VerificationRecipe } from "./evidence-contract.js";
import {
  MAX_VERIFIER_OUTPUT_BYTES,
  VERIFIER_PROCESS_ERROR_CODES,
  VERIFIER_PROCESS_LAYERS,
  hermeticVerifierEnvironment,
  type VerifierClock,
} from "./verifier-process-contract.js";
import {
  MAX_CONSUMED_GRANT_MEMORY,
  createNodeProcessLauncher,
  runVerifierProcess,
  type LaunchedProcess,
  type ProcessLauncher,
  type RunVerifierProcessInput,
  type RunVerifierProcessResult,
  type VerifierActivation,
  type VerifierExitObservation,
} from "./verifier-process.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_IDENTITY = "a1".repeat(20);
const SLOW = 30_000;

/**
 * Every refusal assertion routes through these two collectors, so the sweep at
 * the end of the file is fed by the cases themselves rather than by a list a
 * later edit could forget to extend.
 */
const SEEN_CODES = new Set<string>();
const SEEN_LAYERS = new Set<string>();

function refusedByProcess(result: RunVerifierProcessResult): {
  code: string;
  layer: string;
} {
  if (result.ok) {
    throw new Error(`expected a refusal, received ${JSON.stringify(result.execution)}`);
  }
  if (result.source !== "PROCESS") {
    throw new Error(`expected a PROCESS refusal, received ${result.source} ${result.failure.code}`);
  }
  SEEN_CODES.add(result.failure.code);
  SEEN_LAYERS.add(result.failure.layer);
  return { code: result.failure.code, layer: result.failure.layer };
}

function refusedByForeign(result: RunVerifierProcessResult): {
  source: string;
  code: string;
  layer: string;
} {
  if (result.ok) {
    throw new Error(`expected a refusal, received ${JSON.stringify(result.execution)}`);
  }
  if (result.source === "PROCESS") {
    throw new Error(`expected a foreign refusal, received PROCESS ${result.failure.code}`);
  }
  return { source: result.source, code: result.failure.code, layer: result.failure.layer };
}

function acceptedRun(result: RunVerifierProcessResult) {
  if (!result.ok) {
    throw new Error(`expected a run, received ${JSON.stringify(result.failure)}`);
  }
  return result;
}

// --- fixtures ---------------------------------------------------------------

function commitFor(seed: string): ActivationCommit {
  const intentId = `intent-${seed}`;
  const outcome = activateEffect(
    makeActivationRequest({
      intent: makeIntent({ intentId }),
      attempt: makeAttempt({ intentId }),
      claim: makeClaim({ intentId }),
    }),
  );
  if (outcome.kind !== "ACTIVATED") {
    throw new Error(`fixture activation refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.commit;
}

function recipeFor(argv: readonly string[]): VerificationRecipe {
  const built = buildVerificationRecipe({
    argv,
    declaredInputs: [],
    declaredOutputPaths: [],
    verifierIdentity: {
      verifierId: "verifier-1",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: "ab".repeat(32),
    },
  });
  if (built.ok !== true) {
    throw new Error(`fixture recipe refused: ${JSON.stringify(built)}`);
  }
  return built.recipe;
}

const nodeScript = (source: string): readonly string[] => [process.execPath, "-e", source];

function inputManifest(): WorkspaceInputManifest {
  const built = buildInputManifest({ baseIdentity: BASE_IDENTITY, entries: [] });
  if (built.ok !== true) {
    throw new Error(`fixture manifest refused: ${JSON.stringify(built)}`);
  }
  return built.manifest;
}

function observation(overrides: { readonly reportedVersion?: string | null }) {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: "node", sha256: "cd".repeat(32) }],
    reportedVersion: overrides.reportedVersion ?? null,
    adapterCapabilitySchemaDigest: "ef".repeat(32),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "linux", arch: "x64", osVersion: "0.0.0" },
    clock: { observedAt: () => "2026-08-09T00:00:00.000Z" },
  });
  if (built.ok !== true) {
    throw new Error(`fixture observation refused: ${JSON.stringify(built)}`);
  }
  return built.observation;
}

const PROVEN = observation({ reportedVersion: "24.16.0" });
const UNPROVEN = observation({});

/** PROVEN truth class, stale digest: passes the launch gate and dies at EXECUTION. */
const PROVEN_TAMPERED: ProviderRuntimeObservation = { ...PROVEN, reportedVersion: "24.99.0" };

function fixedClock(): VerifierClock {
  let tick = 0;
  return {
    now: () => `2026-08-09T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    monotonicMs: () => tick * 1000,
  };
}

function counting(inner: ProcessLauncher): {
  launcher: ProcessLauncher;
  invocations: () => number;
} {
  let invocations = 0;
  return {
    launcher: {
      launch: (spec) => {
        invocations += 1;
        return inner.launch(spec);
      },
    },
    invocations: () => invocations,
  };
}

/** Only for the two outcomes no real OS produces on demand. */
function fakeLauncher(closed: Promise<VerifierExitObservation>): ProcessLauncher {
  return {
    launch: (): LaunchedProcess => ({
      pid: 4242,
      closed,
      onStdout: () => undefined,
      onStderr: () => undefined,
      kill: () => undefined,
    }),
  };
}

type Overrides = Partial<RunVerifierProcessInput>;

function inputFor(
  seed: string,
  argv: readonly string[],
  launcher: ProcessLauncher,
  overrides: Overrides = {},
): RunVerifierProcessInput {
  const commit = commitFor(seed);
  return {
    recipe: recipeFor(argv),
    inputManifest: inputManifest(),
    candidateBaseIdentity: BASE_IDENTITY,
    activation: { intent: commit.intent, attempt: commit.attempt, grant: commit.grant },
    wrapperIdentity: "wrapper-1",
    candidateRoot: PACKAGE_ROOT,
    runtimeObservation: PROVEN,
    outputs: [],
    launcher,
    clock: fixedClock(),
    baseEnvironment: process.env,
    ...overrides,
  };
}

// --- accepted runs ----------------------------------------------------------

describe("an accepted sealed recipe runs exactly as sealed", () => {
  it(
    "reports COMPLETED with the argv it actually handed the launcher",
    async () => {
      const argv = nodeScript('process.stdout.write("ok")');
      const result = acceptedRun(
        await runVerifierProcess(inputFor("ok", argv, createNodeProcessLauncher())),
      );
      expect(result.execution.disposition).toBe("COMPLETED");
      expect(result.execution.exitCode).toBe(0);
      expect([...result.execution.argv]).toEqual([...argv]);
      expect(Buffer.from(result.capture.stdout.bytes).toString("utf8")).toBe("ok");
      expect(result.capture.stdout.truncated).toBe(false);
    },
    SLOW,
  );

  it(
    "still admits a proven FAILED run rather than discarding it",
    async () => {
      const result = acceptedRun(
        await runVerifierProcess(
          inputFor("failed", nodeScript("process.exit(3)"), createNodeProcessLauncher()),
        ),
      );
      expect(result.execution.disposition).toBe("FAILED");
      expect(result.execution.exitCode).toBe(3);
    },
    SLOW,
  );

  it(
    "keeps bytes still in flight when the child itself has already exited",
    async () => {
      // The child hands its stdout to a detached grandchild and exits at once,
      // so 'exit' fires while the pipe is still open and still carrying bytes.
      // Resolving on 'exit' rather than 'close' silently loses that tail.
      const script =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e'," +
        "\"setTimeout(()=>process.stdout.write('tail'),300)\"]," +
        "{stdio:['ignore','inherit','ignore'],detached:true});" +
        "c.unref();process.stdout.write('head');";
      const result = acceptedRun(
        await runVerifierProcess(
          inputFor("trailing", nodeScript(script), createNodeProcessLauncher()),
        ),
      );
      expect(Buffer.from(result.capture.stdout.bytes).toString("utf8")).toBe("headtail");
      expect(result.execution.disposition).toBe("COMPLETED");
    },
    SLOW,
  );

  it("keeps daemon environment out of the child", () => {
    const hermetic = hermeticVerifierEnvironment({
      PATH: "/usr/bin",
      MOE_BOOTSTRAP_TOKEN: "token-secret-1",
      LC_ALL: "en_US.UTF-8",
    });
    expect(hermetic["MOE_BOOTSTRAP_TOKEN"]).toBeUndefined();
    expect(hermetic["PATH"]).toBe("/usr/bin");
    expect(hermetic["LC_ALL"]).toBe("C");
  });
});

// --- launch gate: nothing may start ----------------------------------------

describe("the launch gate refuses before any child exists", () => {
  it("refuses a tampered recipe seal", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("seal", nodeScript("process.exit(0)"), launcher);
    const tampered: VerificationRecipe = { ...input.recipe, argv: [process.execPath, "-e", "1"] };
    const seen = refusedByProcess(await runVerifierProcess({ ...input, recipe: tampered }));
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_RECIPE_SEAL_INVALID", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });

  it("refuses an input manifest whose digest no longer recomputes", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("manifest", nodeScript("process.exit(0)"), launcher);
    const stale: WorkspaceInputManifest = { ...input.inputManifest, baseIdentity: "b2".repeat(20) };
    const seen = refusedByProcess(await runVerifierProcess({ ...input, inputManifest: stale }));
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_INPUT_MANIFEST_STALE", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });

  it("refuses a manifest sealed against a different candidate base", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("base", nodeScript("process.exit(0)"), launcher);
    const seen = refusedByProcess(
      await runVerifierProcess({ ...input, candidateBaseIdentity: "b2".repeat(20) }),
    );
    expect(seen.code).toBe("VERIFIER_PROCESS_INPUT_MANIFEST_STALE");
    expect(invocations()).toBe(0);
  });

  it("refuses an unproven runtime observation itself, before spawning", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("unproven", nodeScript("process.exit(0)"), launcher);
    const seen = refusedByProcess(
      await runVerifierProcess({ ...input, runtimeObservation: UNPROVEN }),
    );
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_RUNTIME_UNPROVEN", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });

  it(
    "leaves a PROVEN-but-unrecomputing observation to the EVIDENCE layer",
    async () => {
      // Sibling of the case above: same field, different defect, different
      // refusing authority. If both collapsed to one layer the gate could be
      // deleted and the suite would stay green.
      const { launcher, invocations } = counting(createNodeProcessLauncher());
      const input = inputFor("stale-observation", nodeScript("process.exit(0)"), launcher);
      const seen = refusedByForeign(
        await runVerifierProcess({ ...input, runtimeObservation: PROVEN_TAMPERED }),
      );
      expect(seen).toEqual({
        source: "EVIDENCE",
        code: "RUNNER_EVIDENCE_OBSERVATION_INVALID",
        layer: "EXECUTION",
      });
      expect(invocations()).toBe(1);
    },
    SLOW,
  );

  it.each([".cmd", ".bat", ".ps1"])("refuses a %s shim rather than taking a shell", async (ext) => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const argv = [resolve(PACKAGE_ROOT, `verify${ext}`), "--run"];
    const seen = refusedByProcess(await runVerifierProcess(inputFor(`shim${ext}`, argv, launcher)));
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_EXECUTABLE_UNSUPPORTED", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });

  it("refuses a candidate root that is not an absolute path", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("cwd", nodeScript("process.exit(0)"), launcher);
    const seen = refusedByProcess(await runVerifierProcess({ ...input, candidateRoot: "candidate" }));
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_WORKSPACE_INVALID", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });

  it("refuses a pre-aborted run without starting anything", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("pre-abort", nodeScript("process.exit(0)"), launcher);
    const seen = refusedByProcess(
      await runVerifierProcess({ ...input, signal: AbortSignal.abort() }),
    );
    expect(seen).toEqual({ code: "VERIFIER_PROCESS_CANCELLED", layer: "LAUNCH_GATE" });
    expect(invocations()).toBe(0);
  });
});

// --- the activation grant ---------------------------------------------------

describe("activation authority is the supervisor's, quoted verbatim", () => {
  it("refuses an already consumed grant at the supervisor's own layer", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("consumed", nodeScript("process.exit(0)"), launcher);
    const grant: ActivationGrant = { ...input.activation.grant, state: "CONSUMED", version: 1 };
    const seen = refusedByForeign(
      await runVerifierProcess({
        ...input,
        activation: { ...input.activation, grant },
      }),
    );
    expect(seen).toEqual({ source: "SUPERVISOR", code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" });
    expect(invocations()).toBe(0);
  });

  it("refuses a triple that does not derive", async () => {
    const { launcher, invocations } = counting(createNodeProcessLauncher());
    const input = inputFor("incoherent", nodeScript("process.exit(0)"), launcher);
    const seen = refusedByForeign(
      await runVerifierProcess({
        ...input,
        activation: { ...input.activation, grant: makeGrant() },
      }),
    );
    expect(seen).toEqual({
      source: "SUPERVISOR",
      code: "ACTIVATION_COMMIT_INCOHERENT",
      layer: "ACTIVATION",
    });
    expect(invocations()).toBe(0);
  });
});

// --- duplicate delivery -----------------------------------------------------

describe("duplicate delivery cannot execute the recipe twice", () => {
  it(
    "adopts an in-flight run instead of launching a second child",
    async () => {
      const { launcher, invocations } = counting(createNodeProcessLauncher());
      const input = inputFor("adopt", nodeScript('process.stdout.write("once")'), launcher);
      const [first, second] = await Promise.all([
        runVerifierProcess(input),
        runVerifierProcess({ ...input, clock: fixedClock() }),
      ]);
      expect(invocations()).toBe(1);
      expect(acceptedRun(first).execution).toBe(acceptedRun(second).execution);
    },
    SLOW,
  );

  it(
    "refuses a replay after the run settled, under the supervisor's grant code",
    async () => {
      const { launcher, invocations } = counting(createNodeProcessLauncher());
      const input = inputFor("replay", nodeScript("process.exit(0)"), launcher);
      acceptedRun(await runVerifierProcess(input));
      const seen = refusedByForeign(await runVerifierProcess({ ...input, clock: fixedClock() }));
      expect(seen).toEqual({ source: "SUPERVISOR", code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" });
      expect(invocations()).toBe(1);
    },
    SLOW,
  );

  it(
    "refuses to adopt a run of a different recipe under one grant",
    async () => {
      const { launcher, invocations } = counting(createNodeProcessLauncher());
      const input = inputFor("divergent", nodeScript('process.stdout.write("a")'), launcher);
      const other = { ...input, recipe: recipeFor(nodeScript('process.stdout.write("b")')) };
      const [first, second] = await Promise.all([
        runVerifierProcess(input),
        runVerifierProcess(other),
      ]);
      acceptedRun(first);
      expect(refusedByProcess(second)).toEqual({
        code: "VERIFIER_PROCESS_GRANT_RUN_DIVERGENT",
        layer: "REGISTRY",
      });
      expect(invocations()).toBe(1);
    },
    SLOW,
  );

  it(
    "names the collision, not the consumption, when a settled grant returns with another recipe",
    async () => {
      // What a settled grant leaves behind is the recipe digest as well as the
      // id. Keeping only the id would answer a genuine two-recipe collision with
      // GRANT_ALREADY_CONSUMED, which names the wrong defect and the wrong layer.
      const { launcher, invocations } = counting(createNodeProcessLauncher());
      const input = inputFor("settled-divergent", nodeScript("process.exit(0)"), launcher);
      acceptedRun(await runVerifierProcess(input));
      const other = {
        ...input,
        recipe: recipeFor(nodeScript('process.stdout.write("b")')),
        clock: fixedClock(),
      };
      expect(refusedByProcess(await runVerifierProcess(other))).toEqual({
        code: "VERIFIER_PROCESS_GRANT_RUN_DIVERGENT",
        layer: "REGISTRY",
      });
      expect(invocations()).toBe(1);
    },
    SLOW,
  );

  it(
    "drops the longest-settled grant past the cap and still refuses the newest",
    async () => {
      // Settled through a fake launcher rather than real children: the bound is
      // on how many grant ids the wrapper retains, not on how many processes a
      // host can spawn. Recipe, manifest and observation are built once, so the
      // only thing that varies across the loop is the grant id being remembered.
      const closed = Promise.resolve<VerifierExitObservation>({ exitCode: 0, signal: null });
      const { launcher, invocations } = counting(fakeLauncher(closed));
      const base = inputFor("cap-base", nodeScript("process.exit(0)"), launcher);
      const activationFor = (seed: string): VerifierActivation => {
        const commit = commitFor(seed);
        return { intent: commit.intent, attempt: commit.attempt, grant: commit.grant };
      };
      const settled = async (activation: VerifierActivation): Promise<RunVerifierProcessResult> =>
        runVerifierProcess({ ...base, activation, clock: fixedClock() });

      const oldest = activationFor("cap-0");
      const nextOldest = activationFor("cap-1");
      const newest = activationFor(`cap-${MAX_CONSUMED_GRANT_MEMORY}`);
      acceptedRun(await settled(oldest));
      acceptedRun(await settled(nextOldest));
      for (let index = 2; index < MAX_CONSUMED_GRANT_MEMORY; index += 1) {
        acceptedRun(await settled(activationFor(`cap-${index}`)));
      }
      acceptedRun(await settled(newest));
      expect(invocations()).toBe(MAX_CONSUMED_GRANT_MEMORY + 1);

      // One id over the cap evicts exactly one id, so everything but the very
      // first is still refused. That pair is what "the memory stays at the cap"
      // means: not merely bounded, and not wholesale forgotten either.
      const consumed = { source: "SUPERVISOR", code: "GRANT_ALREADY_CONSUMED", layer: "GRANT" };
      expect(refusedByForeign(await settled(newest))).toEqual(consumed);
      expect(refusedByForeign(await settled(nextOldest))).toEqual(consumed);
      expect(invocations()).toBe(MAX_CONSUMED_GRANT_MEMORY + 1);

      // Probed last: a forgotten grant is admitted, and being admitted puts it
      // back into the memory, which would evict an id the two lines above read.
      acceptedRun(await settled(oldest));
      expect(invocations()).toBe(MAX_CONSUMED_GRANT_MEMORY + 2);
    },
    SLOW,
  );
});

// --- bounded, cancellable, reaped ------------------------------------------

describe("time, cancellation and volume have distinct outcomes", () => {
  it(
    "refuses a run that outlives its deadline and still reports what it saw",
    async () => {
      const argv = nodeScript('process.stdout.write("slow");setTimeout(() => {}, 30000)');
      const result = await runVerifierProcess(
        inputFor("timeout", argv, createNodeProcessLauncher(), { timeoutMs: 400 }),
      );
      expect(refusedByProcess(result)).toEqual({
        code: "VERIFIER_PROCESS_TIMED_OUT",
        layer: "CAPTURE",
      });
      if (result.ok) {
        throw new Error("unreachable");
      }
      expect(result.capture?.stdout.byteLength).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "refuses a run cancelled after it started",
    async () => {
      const controller = new AbortController();
      const argv = nodeScript('process.stdout.write("go");setTimeout(() => {}, 30000)');
      const running = runVerifierProcess(
        inputFor("mid-abort", argv, createNodeProcessLauncher(), { signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 300);
      expect(refusedByProcess(await running)).toEqual({
        code: "VERIFIER_PROCESS_CANCELLED",
        layer: "CAPTURE",
      });
    },
    SLOW,
  );

  it(
    "refuses an overflowing stream and marks the capture truncated",
    async () => {
      const chunks = Math.ceil(MAX_VERIFIER_OUTPUT_BYTES / 65536) + 8;
      const argv = nodeScript(
        `const b="x".repeat(65536);for(let i=0;i<${chunks};i+=1)process.stdout.write(b);setTimeout(() => {}, 30000)`,
      );
      const result = await runVerifierProcess(
        inputFor("overflow", argv, createNodeProcessLauncher()),
      );
      expect(refusedByProcess(result)).toEqual({
        code: "VERIFIER_PROCESS_OUTPUT_OVERFLOW",
        layer: "CAPTURE",
      });
      if (result.ok) {
        throw new Error("unreachable");
      }
      expect(result.capture?.stdout.truncated).toBe(true);
      expect(result.capture?.stdout.byteLength).toBeLessThanOrEqual(MAX_VERIFIER_OUTPUT_BYTES);
    },
    SLOW,
  );

  it("refuses a close that reports neither an exit code nor a signal", async () => {
    const launcher = fakeLauncher(Promise.resolve({ exitCode: null, signal: null }));
    const result = await runVerifierProcess(inputFor("ambiguous", nodeScript("1"), launcher));
    expect(refusedByProcess(result)).toEqual({
      code: "VERIFIER_PROCESS_EXIT_AMBIGUOUS",
      layer: "CAPTURE",
    });
    expect("execution" in result).toBe(false);
  });

  it(
    "refuses a tree that never closes after being killed",
    async () => {
      const launcher = fakeLauncher(new Promise<VerifierExitObservation>(() => undefined));
      const result = await runVerifierProcess(
        inputFor("unreaped", nodeScript("1"), launcher, { timeoutMs: 100, reapGraceMs: 200 }),
      );
      expect(refusedByProcess(result)).toEqual({
        code: "VERIFIER_PROCESS_TREE_UNREAPED",
        layer: "REAP",
      });
    },
    SLOW,
  );

  it(
    "refuses a launcher that cannot start the executable",
    async () => {
      const missing = resolve(PACKAGE_ROOT, "no-such-verifier-binary.exe");
      const result = await runVerifierProcess(
        inputFor("enoent", [missing, "--run"], createNodeProcessLauncher()),
      );
      expect(refusedByProcess(result)).toEqual({
        code: "VERIFIER_PROCESS_SPAWN_FAILED",
        layer: "SPAWN",
      });
    },
    SLOW,
  );
});

// --- closed vocabulary ------------------------------------------------------

describe("the refusal vocabulary is closed and fully reachable", () => {
  it("reaches every declared code and every declared layer", () => {
    expect(SEEN_CODES.size).toBeGreaterThan(0);
    expect([...SEEN_CODES].sort()).toEqual([...VERIFIER_PROCESS_ERROR_CODES].sort());
    expect([...SEEN_LAYERS].sort()).toEqual([...VERIFIER_PROCESS_LAYERS].sort());
  });
});

// --- plain-Node root smoke --------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * vitest resolves a `./foo.js` specifier back to `foo.ts`; Node does not. cwd is
 * the package root so the bare specifier resolves through this package's own
 * exports map, which is the resolution a dependent package actually gets.
 */
const probe = async (source: string): Promise<unknown> => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: PACKAGE_ROOT },
  );
  return JSON.parse(stdout) as unknown;
};

const VALUE_EXPORTS = [
  "runVerifierProcess",
  "createNodeProcessLauncher",
  "hermeticVerifierEnvironment",
  "VERIFIER_PROCESS_ERROR_CODES",
  "VERIFIER_PROCESS_LAYERS",
  "MAX_VERIFIER_OUTPUT_BYTES",
];

const TYPE_ONLY_EXPORTS = [
  "RunVerifierProcessInput",
  "RunVerifierProcessResult",
  "VerifierProcessRefusal",
  "VerifierProcessFailure",
  "VerifierProcessErrorCode",
  "VerifierProcessLayer",
  "VerifierCapture",
  "VerifierStreamCapture",
  "VerifierClock",
  "ProcessLauncher",
  "LaunchedProcess",
];

const RUN_THROUGH_ROOT = `
const report = (value) => process.stdout.write(JSON.stringify(value));
try {
  const ns = await import("@moe/runner");
  const built = ns.buildVerificationRecipe({
    argv: [process.execPath, "-e", "process.exit(0)"],
    declaredInputs: [],
    declaredOutputPaths: [],
    verifierIdentity: {
      verifierId: "verifier-1",
      verifierVersion: "1.0.0",
      capabilitySchemaDigest: "ab".repeat(32),
    },
  });
  const manifest = ns.buildInputManifest({ baseIdentity: "a1".repeat(20), entries: [] });
  const closure = [{ kind: "EXECUTABLE", path: "node", sha256: "cd".repeat(32) }];
  const observed = ns.buildProviderRuntimeObservation({
    resolvedRuntimeClosure: closure,
    reportedVersion: "24.16.0",
    adapterCapabilitySchemaDigest: "ef".repeat(32),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "linux", arch: "x64", osVersion: "0.0.0" },
    clock: { observedAt: () => "2026-08-09T00:00:00.000Z" },
  });
  const lease = {
    leaseId: "lease-1", kind: "ASSIGNMENT", ownerSessionRef: "session-1",
    leaseToken: "token-secret-1", epoch: 7, state: "ACTIVE",
    serverWallDeadline: 1700000090, bootId: "boot-1", monotonicObservation: 4242,
    authorityHashRef: "d4".repeat(32), version: 3,
  };
  const activated = ns.activateEffect({
    intent: {
      protocolVersion: ns.SUPERVISOR_EFFECT_PROTOCOL_VERSION, intentId: "intent-1",
      aggregateId: "aggregate-1", expectedGraphEpoch: 11, leaseBinding: lease,
      inputBinding: "a1".repeat(32), predecessorCursor: "cursor-42", desiredState: "RUNNING",
      idempotencyKey: "idem-1", runtimeObservationDigest: "b2".repeat(32),
      state: "ARMED", version: 5,
    },
    attempt: {
      attemptId: "attempt-1", aggregateId: "aggregate-1", intentId: "intent-1",
      state: "LAUNCH_REQUESTED", version: 2,
    },
    claim: {
      claimId: "claim-1", intentId: "intent-1", wrapperIdentity: "wrapper-1",
      lockIdentity: "lock-1", claimedAt: "2026-08-08T00:00:00.000Z",
    },
    tombstone: null,
    leaseProof: {
      leaseToken: "token-secret-1", epoch: 7, authorityHashRef: "d4".repeat(32),
      ownerSessionRef: "session-1", expectedVersion: 3,
    },
    wrapperIdentity: "wrapper-1",
    lockIdentity: "lock-1",
    observedGraphEpoch: 11,
    desiredState: "RUNNING",
    dependencyWitnesses: [
      { witnessId: "witness-1", expectedDigest: "29".repeat(32), observedDigest: "29".repeat(32) },
    ],
    observedRuntimeDigest: "b2".repeat(32),
  });
  if (activated.kind !== "ACTIVATED" || built.ok !== true || manifest.ok !== true || observed.ok !== true) {
    report({ outcome: "FIXTURE_REFUSED", activation: activated.kind });
  } else {
    let tick = 0;
    const run = await ns.runVerifierProcess({
      recipe: built.recipe,
      inputManifest: manifest.manifest,
      candidateBaseIdentity: "a1".repeat(20),
      activation: {
        intent: activated.commit.intent,
        attempt: activated.commit.attempt,
        grant: activated.commit.grant,
      },
      wrapperIdentity: "wrapper-1",
      candidateRoot: process.cwd(),
      runtimeObservation: observed.observation,
      outputs: [],
      launcher: ns.createNodeProcessLauncher(),
      clock: {
        now: () => "2026-08-09T00:00:0" + String(tick++) + ".000Z",
        monotonicMs: () => tick * 1000,
      },
      baseEnvironment: process.env,
    });
    const names = ${JSON.stringify([...VALUE_EXPORTS, ...TYPE_ONLY_EXPORTS])};
    report({
      outcome: "RAN",
      ok: run.ok === true,
      disposition: run.ok === true ? run.execution.disposition : run.failure.code,
      defined: names.filter((name) => ns[name] !== undefined),
    });
  }
} catch (error) {
  report({ outcome: "FAILED", code: error.code ?? "NO_CODE", message: String(error.message) });
}
`;

it(
  "exercises the wrapper through the @moe/runner root under plain Node",
  async () => {
    expect(await probe(RUN_THROUGH_ROOT)).toEqual({
      outcome: "RAN",
      ok: true,
      disposition: "COMPLETED",
      // Type-only names must be absent from the runtime namespace, and every
      // value export must be present: `defined` is exactly the value list.
      defined: VALUE_EXPORTS,
    });
  },
  SLOW,
);
