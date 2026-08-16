import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as nativeJoin } from "node:path";

import { afterAll, expect, it } from "vitest";

import { resolveBrokerBinary } from "../../platform/windows/windows-broker-path.js";
import {
  WINDOWS_PROCESS_CODES,
  WINDOWS_PROCESS_LAYERS,
} from "../../platform/windows/windows-process-contract.js";
import { canonicalDigest } from "../../canonical.js";
import { CLAUDE_CAPABILITIES, CLAUDE_PROOF_METHODS } from "./claude-capabilities.js";
import * as hostRuntime from "./claude-host-runtime.js";
import { observationDigestInput, type ProviderRuntimeObservation } from "./claude-observation.js";
import { CLAUDE_RUNTIME_PIN_ERROR_CODES } from "./claude-runtime-pin-closure.js";

/**
 * The production Windows host adapter behind Claude runtime pinning.
 *
 * Everything here drives the REAL surface: the real installed executable, the
 * real release broker, real streamed digests, a real `--version`. There is no
 * injected filesystem, clock, probe port or process seam anywhere in this file,
 * because the absence of those seams from the public surface is the defect this
 * module exists to close — a test that reached for one would prove the opposite.
 */

/**
 * Resolved through the module NAMESPACE, not a named import. A missing named
 * import fails the whole file to load, which reports ZERO executed tests and is
 * indistinguishable from a suite that tested nothing; going through the
 * namespace makes every case below execute and fail on its own assertion.
 */
type ObserveInstalledClaudeRuntime = (input: unknown) => Promise<unknown>;

function observe(): ObserveInstalledClaudeRuntime {
  const exported = (hostRuntime as unknown as Record<string, unknown>)["observeInstalledClaudeRuntime"];
  expect(typeof exported, "production observeInstalledClaudeRuntime export is absent").toBe("function");
  return exported as ObserveInstalledClaudeRuntime;
}

const WIN = process.platform === "win32";
const RUNTIME_LAYER = "RUNTIME";
const PLATFORM_REFUSAL = Object.freeze({ code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: RUNTIME_LAYER });

/** Long enough for the broker to settle a real launch, short enough to gate a suite. */
const PROBE_TIMEOUT_MS = 4_000;
const CASE_TIMEOUT_MS = 60_000;

interface Refusal {
  readonly code: string;
  readonly layer: string | null;
}

/** Long enough for a category sentence, far too short to carry an install path. */
const MAX_REFUSAL_MESSAGE_CHARS = 200;

/**
 * A drive-qualified path, a UNC share, or a POSIX absolute path. Task rail 2
 * says a refusal names a CATEGORY, never a location, so any of these shapes in a
 * public message is a leak regardless of which path it happens to be.
 */
const PATH_SHAPED = /[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:tmp|var|home|Users|private)\//u;

/**
 * `secrets` are the exact input strings this case fed in. The regex above catches
 * the general shape; this catches an echo that arrives in some other form, which
 * is the failure mode a shape check alone cannot see.
 */
function refusalOf(result: unknown, label: string, secrets: readonly string[] = []): Refusal {
  expect(typeof result, `${label}: result is not a record`).toBe("object");
  const record = result as Record<string, unknown>;
  expect(record["ok"], `${label}: a refusal must never report ok`).not.toBe(true);
  expect(record["observation"], `${label}: a refusal must carry no observation`).toBeUndefined();
  expect(record["profile"], `${label}: a refusal must carry no capability profile`).toBeUndefined();
  expect(record["truthClass"], `${label}: a refusal must never be PROVEN`).not.toBe("PROVEN");
  expect(typeof record["code"], `${label}: refusal carries no stable code`).toBe("string");

  // Task rail 2: the public message must not echo a runtime path, argv value,
  // environment value or secret. Asserted HERE so every case in the sweep is
  // covered by it rather than one bespoke test.
  expect(typeof record["message"], `${label}: refusal carries no message`).toBe("string");
  const message = record["message"] as string;
  expect(message.length, `${label}: refusal message is empty`).toBeGreaterThan(0);
  expect(message.length, `${label}: refusal message is unbounded`).toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE_CHARS);
  expect(PATH_SHAPED.test(message), `${label}: refusal message echoes a path: ${message}`).toBe(false);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    expect(message.includes(secret), `${label}: refusal message echoes an input value: ${message}`).toBe(false);
  }

  const layer = record["layer"];
  return { code: record["code"] as string, layer: typeof layer === "string" ? layer : null };
}

/** The input strings a case supplied, so a message can be checked for echoing them. */
function inputSecrets(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  return Object.values(input as Record<string, unknown>).filter(
    (value): value is string => typeof value === "string",
  );
}

/** Windows-shaped even off Windows: the platform gate answers before any path is read. */
const roots: string[] = [];

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(nativeJoin(tmpdir(), "moe-host-runtime-")));
  roots.push(root);
  return root;
}

/**
 * Blocks reads with a real deny ACE — the genuine host condition, not a stubbed
 * fs error. Tracked so the ACE is lifted before cleanup: a denied entry that
 * outlives the suite would strand the fixture tree in the user's temp directory.
 */
const deniedReads: string[] = [];

function denyRead(path: string): void {
  const user = process.env["USERNAME"];
  if (typeof user !== "string" || user.length === 0) return;
  execFileSync("icacls.exe", [path, "/deny", `${user}:(R)`], { stdio: "ignore" });
  deniedReads.push(path);
}

afterAll(() => {
  for (const path of deniedReads) {
    try {
      execFileSync("icacls.exe", [path, "/remove:d", process.env["USERNAME"] as string], { stdio: "ignore" });
    } catch {
      // Best effort: rmSync below still clears the tree via the parent directory.
    }
  }
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** `where.exe` rather than a hard-coded install path: the host owns where Claude lives. */
function installedClaudeExecutable(): string | null {
  if (!WIN) return null;
  try {
    const found = execFileSync("where.exe", ["claude.exe"], { encoding: "utf8" })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().endsWith(".exe"));
    return found.length === 0 ? null : realpathSync(found[0] as string);
  } catch {
    return null;
  }
}

function brokerIsBuilt(): boolean {
  return typeof resolveBrokerBinary() === "string";
}

interface RefusalCase {
  readonly name: string;
  readonly input: unknown;
  readonly code: string;
  readonly layer: string | null;
  /**
   * Pinned where more than one ROUTE shares a code. CLAUDE_RUNTIME_OBSERVATION_INVALID
   * answers both "the probe did not exit cleanly" and "the output is not a version",
   * so a code-only assertion cannot tell which guard ran.
   */
  readonly message?: string | undefined;
}

/**
 * Every fixture below is VALID AT EVERY EARLIER LAYER, so the case under test is
 * the one that answers. A fixture that also broke an earlier rule would still be
 * green while testing the wrong guard.
 */
function refusalCases(): readonly RefusalCase[] {
  const cases: RefusalCase[] = [];
  const root = WIN ? fixtureRoot() : "C:\\moe-absent-root";
  const good = nativeJoin(root, "claude.exe");
  if (WIN) writeFileSync(good, "fixture bytes");

  const runtime = (name: string, input: unknown, code: string): void => {
    cases.push({ name, input, code, layer: RUNTIME_LAYER });
  };

  runtime("input is not a record", null, "CLAUDE_RUNTIME_OBSERVATION_INVALID");
  runtime("input is a string", "C:\\anything", "CLAUDE_RUNTIME_OBSERVATION_INVALID");
  runtime("input is an array", [], "CLAUDE_RUNTIME_OBSERVATION_INVALID");
  runtime("input omits the executable", { installedRoot: root }, "CLAUDE_RUNTIME_OBSERVATION_INVALID");
  runtime(
    "input carries an extra key",
    { installedRoot: root, executablePath: good, fs: {} },
    "CLAUDE_RUNTIME_OBSERVATION_INVALID",
  );
  runtime(
    "the executable path is not a string",
    { installedRoot: root, executablePath: 7 },
    "CLAUDE_RUNTIME_OBSERVATION_INVALID",
  );
  runtime(
    "the probe timeout is not a positive safe integer",
    { installedRoot: root, executablePath: good, versionTimeoutMs: 0 },
    "CLAUDE_RUNTIME_OBSERVATION_INVALID",
  );
  runtime(
    "the executable path text is oversized",
    { installedRoot: root, executablePath: `${root}\\${"a".repeat(500)}.exe` },
    "CLAUDE_RUNTIME_PATH_INVALID",
  );
  runtime(
    "the executable path is relative",
    { installedRoot: root, executablePath: "claude.exe" },
    "CLAUDE_RUNTIME_PATH_INVALID",
  );

  if (!WIN) {
    return Object.freeze(cases);
  }

  const missing = nativeJoin(root, "absent.exe");
  runtime("the executable is missing", { installedRoot: root, executablePath: missing }, "CLAUDE_RUNTIME_PATH_MISSING");

  const directory = nativeJoin(root, "directory.exe");
  mkdirSync(directory);
  runtime(
    "the executable is a directory",
    { installedRoot: root, executablePath: directory },
    "CLAUDE_RUNTIME_PATH_NOT_FILE",
  );

  // A junction needs no Administrator rights, and the segment walk rejects a
  // reparse point ANYWHERE in the path — which is what makes this fixture legal.
  const real = nativeJoin(root, "real");
  mkdirSync(real);
  writeFileSync(nativeJoin(real, "claude.exe"), "fixture bytes");
  const link = nativeJoin(root, "link");
  symlinkSync(real, link, "junction");
  runtime(
    "the executable path crosses a reparse point",
    { installedRoot: root, executablePath: nativeJoin(link, "claude.exe") },
    "CLAUDE_RUNTIME_PATH_REPARSE",
  );

  const outside = fixtureRoot();
  const escaped = nativeJoin(outside, "claude.exe");
  writeFileSync(escaped, "fixture bytes");
  runtime(
    "the executable escapes the installed root",
    { installedRoot: root, executablePath: escaped },
    "CLAUDE_RUNTIME_PATH_ESCAPE",
  );

  // node.exe answers `--version` with `v24.16.0` and exits 0: a real, clean
  // execution whose output is not the shape this provider reports. Refusing it
  // proves the parse is conservative rather than "any text is a version".
  const foreign = nativeJoin(root, "foreign.exe");
  copyFileSync(process.execPath, foreign);
  cases.push({
    name: "the version output is not the shape this provider reports",
    input: { installedRoot: root, executablePath: foreign, versionTimeoutMs: PROBE_TIMEOUT_MS },
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    layer: RUNTIME_LAYER,
    message: "installed runtime request probe printed output that is not the version shape this provider reports",
  });

  // A REAL nonzero exit, which is a different route to the same code: hostname.exe
  // is a valid image that rejects `--version` and exits 1 with empty stdout, so the
  // exit-code guard answers BEFORE the parse ever sees a string.
  const rejecting = nativeJoin(root, "rejecting.exe");
  copyFileSync(nativeJoin(process.env["SYSTEMROOT"] ?? "C:\\Windows", "System32", "hostname.exe"), rejecting);
  cases.push({
    name: "the version probe does not exit cleanly",
    input: { installedRoot: root, executablePath: rejecting, versionTimeoutMs: PROBE_TIMEOUT_MS },
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    layer: RUNTIME_LAYER,
    message: "installed runtime request probe did not exit cleanly, so no version was observed",
  });

  // Cut short by its own bound. Named for what it PROVES rather than for the
  // mechanism: the kill leaves no output, so the shape guard is what refuses and
  // the observation stays unproven. `versionTimeoutMs` is a kill bound, never a
  // floor — the broker settles on its completed frame.
  cases.push({
    name: "a probe cut short by its own bound yields no version",
    input: { installedRoot: root, executablePath: foreign, versionTimeoutMs: 1 },
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID",
    layer: RUNTIME_LAYER,
    message: "installed runtime request probe printed output that is not the version shape this provider reports",
  });

  // A real, contained, plain file that simply cannot be READ: every earlier rule
  // passes, the file exists, and the inspection still cannot prove its bytes. An
  // observation that cannot read its own closure must fail closed rather than
  // report a digest it never computed.
  const unreadable = nativeJoin(root, "unreadable.exe");
  writeFileSync(unreadable, "fixture bytes");
  denyRead(unreadable);
  runtime(
    "the executable cannot be read",
    { installedRoot: root, executablePath: unreadable },
    "CLAUDE_RUNTIME_PATH_MISSING",
  );

  // A real file that is not a loadable image: every runtime-layer rule passes and
  // the WINDOWS layer is the one that answers, with its own code and its own layer.
  const notAnImage = nativeJoin(root, "not-an-image.exe");
  writeFileSync(notAnImage, "not a portable executable");
  cases.push({
    name: "the executable is not a loadable image",
    input: { installedRoot: root, executablePath: notAnImage, versionTimeoutMs: PROBE_TIMEOUT_MS },
    code: "PROCESS_BOUNDARY_BROKER_REFUSED",
    layer: "BROKER_NATIVE",
  });

  return Object.freeze(cases);
}

const CASES = refusalCases();

it("generated a positive number of fail-closed cases", () => {
  expect(CASES.length, "a sweep that generates zero cases passes while testing nothing").toBeGreaterThan(0);
  expect(CASES.length).toBe(WIN ? 18 : 9);
  // The route pin below is CONDITIONAL on `message` being set, so dropping the
  // field would disable it in silence rather than redden. Counted here so the
  // pins have to exist, not merely be honoured where they happen to survive.
  const pinned = CASES.filter((testCase) => testCase.message !== undefined);
  expect(pinned.length, "the exact-route message pins vanished").toBe(WIN ? 3 : 0);
});

for (const [index, testCase] of CASES.entries()) {
  it(
    `fails closed when ${testCase.name}`,
    async () => {
      const result = await observe()(testCase.input);
      const refusal = refusalOf(result, testCase.name, inputSecrets(testCase.input));
      // Off Windows the platform gate answers FIRST, by design; asserting the
      // real answer per host beats skipping, which would prove nothing at all.
      const expected = WIN ? testCase : PLATFORM_REFUSAL;
      expect(refusal.code, `case ${index} refused with the wrong code`).toBe(expected.code);
      expect(refusal.layer, `case ${index} refused at the wrong layer`).toBe(expected.layer);
      // Where two ROUTES share a code, the exact message is the only thing that
      // says which guard answered.
      if (WIN && testCase.message !== undefined) {
        expect((result as Record<string, unknown>)["message"], `case ${index} took the wrong route`)
          .toBe(testCase.message);
      }
      if (refusal.layer === RUNTIME_LAYER) {
        expect(CLAUDE_RUNTIME_PIN_ERROR_CODES).toContain(refusal.code);
      } else {
        expect(WINDOWS_PROCESS_CODES).toContain(refusal.code);
        expect(WINDOWS_PROCESS_LAYERS).toContain(refusal.layer);
      }
    },
    CASE_TIMEOUT_MS,
  );
}

/*
 * THE DRIFT ARM HAS NO RUNTIME CASE ON win32, DELIBERATELY. Do not reinvent one.
 *
 * Production inspects the closure, probes `--version`, inspects again, and refuses
 * CLAUDE_RUNTIME_PIN_SOURCE_DRIFT at layer RUNTIME when the two digests differ.
 * Reaching that branch from a test needs the closure mutated inside the window
 * between the child's exit and the second inspection's open, and Windows forbids
 * that interleaving:
 *   - while the child lives, the OS holds its image MAPPED, so an in-place write is
 *     refused outright and an image rotation collides with the broker's own open,
 *     which surfaces as PROCESS_BOUNDARY_BROKER_REFUSED — the environment
 *     answering, not this guard;
 *   - since completion became child-driven (abc3dcf), `versionTimeoutMs` is a KILL
 *     BOUND and never a floor, so that window is sub-millisecond: the whole
 *     observation measures ~170ms warm against a node.exe copy;
 *   - and a probe killed by its bound refuses BEFORE the comparison is reached,
 *     because a non-clean exit is answered above it.
 * Measured on this host across 8 attempts: 4x PROCESS_BOUNDARY_BROKER_REFUSED,
 * 3x CLAUDE_RUNTIME_OBSERVATION_INVALID, 0 drifts. A case that needs an
 * OS-forbidden interleaving is a race, not a test, and bounded retries over a race
 * cannot be deterministically green.
 *
 * The guard is proven load-bearing by an epic-rail-6 mutation drill instead:
 * inverting `digestsOf(before) !== digestsOf(after)` in claude-host-runtime.ts
 * makes the conformance leg below refuse CLAUDE_RUNTIME_PIN_SOURCE_DRIFT at layer
 * RUNTIME rather than observe, which pins the comparison to the live path and to
 * that exact code and layer. Recorded in the task's completion note.
 * (Governor ruling 2026-08-16 02:10Z on this task, option (a).)
 */

it(
  "observes the really installed runtime, or refuses with the host's own stable code",
  async () => {
    if (!WIN) {
      const refusal = refusalOf(
        await observe()({ installedRoot: "C:\\x", executablePath: "C:\\x\\claude.exe" }),
        "conformance",
      );
      expect(refusal.code).toBe(PLATFORM_REFUSAL.code);
      expect(refusal.layer).toBe(PLATFORM_REFUSAL.layer);
      return;
    }
    const executable = installedClaudeExecutable();
    expect(executable, "no claude.exe on PATH: the PROVEN arm cannot be certified on this host").not.toBeNull();
    const input = {
      installedRoot: dirname(executable as string),
      executablePath: executable as string,
      versionTimeoutMs: PROBE_TIMEOUT_MS,
    };
    const result = await observe()(input);
    if (!brokerIsBuilt()) {
      const refusal = refusalOf(result, "conformance");
      expect(refusal.code).toBe("PROCESS_BOUNDARY_BROKER_UNRESOLVED");
      expect(WINDOWS_PROCESS_LAYERS).toContain(refusal.layer);
      return;
    }
    const record = result as Record<string, unknown>;
    expect(record["ok"], `the real runtime did not observe: ${JSON.stringify(record["code"] ?? null)}`).toBe(true);

    const observation = record["observation"] as Record<string, unknown>;
    const closure = observation["resolvedRuntimeClosure"] as readonly Record<string, unknown>[];
    expect(closure).toHaveLength(1);
    expect(closure[0]?.["kind"]).toBe("EXECUTABLE");
    expect(closure[0]?.["sha256"]).toMatch(/^[0-9a-f]{64}$/u);
    // Two INDEPENDENT oracles, because a shape check cannot tell a real digest
    // from an echoed one, nor a real execution from a plausible literal.
    expect(closure[0]?.["sha256"], "the closure digest is not the real bytes of the real file").toBe(
      createHash("sha256").update(readFileSync(executable as string)).digest("hex"),
    );
    expect(observation["reportedVersion"], "the reported version is not what the runtime really prints").toBe(
      execFileSync(executable as string, ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim(),
    );
    expect(observation["reportedVersion"]).not.toBeNull();
    expect(observation["truthClass"]).toBe("PROVEN");
    expect(observation["pinningMethod"]).toBe("CONTENT_ADDRESSED_COPY");
    expect(observation["observationDigest"]).toMatch(/^[0-9a-f]{64}$/u);
    // RECOMPUTED through the production digest input, not merely shape-checked:
    // a digest that is echoed rather than derived passes a hex match and fails here.
    const { observationDigest, ...body } = observation as unknown as ProviderRuntimeObservation;
    expect(canonicalDigest(observationDigestInput(body))).toBe(observationDigest);

    const facts = record["facts"] as Record<string, unknown>;
    expect(facts["reportedVersion"]).toBe(observation["reportedVersion"]);
    expect(facts["adapterCapabilitySchemaDigest"]).toBe(observation["adapterCapabilitySchemaDigest"]);
    expect(facts["platformIdentity"]).toStrictEqual(observation["platformIdentity"]);

    const profile = record["profile"] as Record<string, unknown>;
    const capabilities = profile["capabilities"] as readonly Record<string, unknown>[];
    expect(capabilities.map((entry) => entry["capability"])).toStrictEqual([...CLAUDE_CAPABILITIES]);
    const supported = capabilities.filter((entry) => entry["status"] === "SUPPORTED");
    expect(supported.map((entry) => entry["capability"])).toStrictEqual(["PIN_METHOD", "VERSION_REPORT"]);
    expect(supported.map((entry) => entry["proofMethod"])).toStrictEqual(["PIN_METHOD_RECORD", "VERSION_RECORD"]);
    expect(capabilities.filter((entry) => entry["status"] === "UNSUPPORTED")).toHaveLength(9);
    for (const entry of capabilities) {
      if (entry["status"] === "UNSUPPORTED") expect(entry["proofMethod"]).toBe("NONE");
      expect(CLAUDE_PROOF_METHODS).toContain(entry["proofMethod"]);
    }
    expect(profile["contextPolicy"]).toBe("HOLD_UNKNOWN");
  },
  CASE_TIMEOUT_MS,
);
