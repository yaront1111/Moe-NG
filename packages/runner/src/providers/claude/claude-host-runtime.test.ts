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

function refusalOf(result: unknown, label: string): Refusal {
  expect(typeof result, `${label}: result is not a record`).toBe("object");
  const record = result as Record<string, unknown>;
  expect(record["ok"], `${label}: a refusal must never report ok`).not.toBe(true);
  expect(record["observation"], `${label}: a refusal must carry no observation`).toBeUndefined();
  expect(record["profile"], `${label}: a refusal must carry no capability profile`).toBeUndefined();
  expect(record["truthClass"], `${label}: a refusal must never be PROVEN`).not.toBe("PROVEN");
  expect(typeof record["code"], `${label}: refusal carries no stable code`).toBe("string");
  const layer = record["layer"];
  return { code: record["code"] as string, layer: typeof layer === "string" ? layer : null };
}

/** Windows-shaped even off Windows: the platform gate answers before any path is read. */
const roots: string[] = [];

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(nativeJoin(tmpdir(), "moe-host-runtime-")));
  roots.push(root);
  return root;
}

afterAll(() => {
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
  runtime(
    "the version output is not the shape this provider reports",
    { installedRoot: root, executablePath: foreign, versionTimeoutMs: PROBE_TIMEOUT_MS },
    "CLAUDE_RUNTIME_OBSERVATION_INVALID",
  );

  // Killed by its own bound before it could print: a clean file, a real launch,
  // and still no version — which must stay UNKNOWN rather than become a guess.
  runtime(
    "the version probe is cut off by its own timeout",
    { installedRoot: root, executablePath: foreign, versionTimeoutMs: 1 },
    "CLAUDE_RUNTIME_OBSERVATION_INVALID",
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
  expect(CASES.length).toBe(WIN ? 16 : 9);
});

for (const [index, testCase] of CASES.entries()) {
  it(
    `fails closed when ${testCase.name}`,
    async () => {
      const result = await observe()(testCase.input);
      const refusal = refusalOf(result, testCase.name);
      // Off Windows the platform gate answers FIRST, by design; asserting the
      // real answer per host beats skipping, which would prove nothing at all.
      const expected = WIN ? testCase : PLATFORM_REFUSAL;
      expect(refusal.code, `case ${index} refused with the wrong code`).toBe(expected.code);
      expect(refusal.layer, `case ${index} refused at the wrong layer`).toBe(expected.layer);
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

it(
  "refuses a closure that drifts while the version probe runs",
  async () => {
    if (!WIN) {
      const refusal = refusalOf(await observe()({ installedRoot: "C:\\x", executablePath: "C:\\x\\y.exe" }), "drift");
      expect(refusal.code).toBe(PLATFORM_REFUSAL.code);
      expect(refusal.layer).toBe(PLATFORM_REFUSAL.layer);
      return;
    }
    const root = fixtureRoot();
    const executable = nativeJoin(root, "drifting.exe");
    copyFileSync(process.execPath, executable);
    const pending = observe()({
      installedRoot: root,
      executablePath: executable,
      versionTimeoutMs: PROBE_TIMEOUT_MS,
    });
    // The probe holds the boundary open for its whole bound, so the swap lands
    // between the two inspection passes rather than racing them. Renaming a
    // running image is legal on Windows; deleting it is not.
    await new Promise((resolve) => {
      setTimeout(resolve, 750);
    });
    renamedAside(executable, nativeJoin(root, "drifted-away.exe"));
    writeFileSync(executable, "different bytes entirely");
    const refusal = refusalOf(await pending, "drift");
    expect(refusal.code).toBe("CLAUDE_RUNTIME_PIN_SOURCE_DRIFT");
    expect(refusal.layer).toBe(RUNTIME_LAYER);
  },
  CASE_TIMEOUT_MS,
);

function renamedAside(from: string, to: string): void {
  execFileSync("cmd.exe", ["/c", "move", "/y", from, to], { stdio: "ignore" });
}

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
