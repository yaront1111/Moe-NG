import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as nativeJoin, win32 } from "node:path";

import { afterAll, expect, it } from "vitest";

import { canonicalDigest } from "../../canonical.js";
import { resolveBrokerBinary } from "../../platform/windows/windows-broker-path.js";
import { observeInstalledClaudeRuntime } from "./claude-host-runtime.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import {
  buildProviderRuntimeObservation,
  observationDigestInput,
  type ProviderRuntimeObservation,
  type RuntimeClosureEntry,
} from "./claude-observation.js";
import * as requestModule from "./claude-runtime-request.js";
import { CLAUDE_RUNTIME_PIN_ERROR_CODES } from "./claude-runtime-pin-closure.js";

/**
 * The hydrator's real job: turn bounded plain data that crossed an authenticated
 * JSON boundary into a runtime pin request whose CAPABILITIES were minted inside
 * this package.
 *
 * Every case below is hostile input, because the defect this factory closes is a
 * caller supplying `fs`, `facts` or `clock` itself. Nothing here injects a port,
 * a clock or a filesystem — reaching for one would prove the opposite of what the
 * factory exists to prove.
 */

/**
 * Resolved through the module NAMESPACE, not a named import. A missing named
 * import fails the whole file to load, which reports ZERO executed tests and is
 * indistinguishable from a suite that tested nothing.
 */
type CreateRequest = (input: unknown) => unknown;

function create(): CreateRequest {
  const exported = (requestModule as unknown as Record<string, unknown>)[
    "createClaudeRuntimePinRequest"
  ];
  expect(typeof exported, "production createClaudeRuntimePinRequest export is absent").toBe(
    "function",
  );
  return exported as CreateRequest;
}

const RUNTIME_LAYER = "RUNTIME";
const INSTALLED_ROOT = "C:\\moe-runner-installed";
const PIN_ROOT = "C:\\moe-runner-pins";
const EXECUTABLE = `${INSTALLED_ROOT}\\claude.exe`;
const LAUNCHER = `${INSTALLED_ROOT}\\claude.cmd`;
const SECOND_EXECUTABLE = `${INSTALLED_ROOT}\\claude-other.exe`;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SCHEMA_DIGEST = "c".repeat(64);
const AT = "2026-08-16T00:00:00.000Z";

/** Long enough for a category sentence, far too short to carry an install path. */
const MAX_REFUSAL_MESSAGE_CHARS = 200;
/** Task rail 2: a refusal names a CATEGORY, never a location. */
const PATH_SHAPED = /[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:tmp|var|home|Users|private)\//u;

/** The exact prose each guard in the factory owns, so a shared code cannot hide a route. */
const MESSAGES = Object.freeze({
  shape: "runtime pin request is not an exact record of quotedObservation, installedRoot and pinRoot",
  text: "a runtime pin request path is not bounded normalized text",
  absolute: "a runtime pin request path is not an absolute local-drive Windows path",
  relative: "a runtime pin request path contains a relative segment",
  control: "a runtime pin request path carries a control character",
  uncanonical: "the quoted observation does not canonicalise into a snapshot this factory can keep",
  digest: "the quoted observation digest does not cover the snapshot this factory kept",
  executable: "the quoted closure does not declare exactly one EXECUTABLE to observe",
  executablePath: "the quoted EXECUTABLE entry does not carry a text path",
  bound: "the quoted closure declares more entries than a runtime closure may hold",
});

const entry = (kind: string, path: string, sha256: string): RuntimeClosureEntry =>
  ({ kind, path, sha256 }) as RuntimeClosureEntry;

/**
 * Built through the PRODUCTION observation builder, so every fixture carries a
 * digest this repository really computes. A hand-written digest would refuse at
 * the coverage guard and every later case would assert the wrong route.
 */
function quoteOf(
  closure: readonly RuntimeClosureEntry[],
  reportedVersion: string | null = "2.1.233 (Claude Code)",
  pinningMethod = "CONTENT_ADDRESSED_COPY",
): ProviderRuntimeObservation {
  const built = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: closure,
    reportedVersion,
    adapterCapabilitySchemaDigest: SCHEMA_DIGEST,
    pinningMethod: pinningMethod as ProviderRuntimeObservation["pinningMethod"],
    platformIdentity: { os: "win32", arch: "x64", osVersion: "10.0.26200" },
    clock: { observedAt: () => AT },
  });
  if (!built.ok) throw new Error(`fixture quote did not build: ${built.code}`);
  return built.observation;
}

const SOUND_QUOTE = quoteOf([entry("EXECUTABLE", EXECUTABLE, DIGEST_A)]);

function sound(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    quotedObservation: SOUND_QUOTE,
    installedRoot: INSTALLED_ROOT,
    pinRoot: PIN_ROOT,
    ...overrides,
  };
}

interface HostileCase {
  readonly name: string;
  readonly input: unknown;
  readonly code: string;
  readonly message: string;
}

function hostileCases(): readonly HostileCase[] {
  const cases: HostileCase[] = [];
  const push = (name: string, input: unknown, code: string, message: string): void => {
    cases.push({ name, input, code, message });
  };
  const shape = (name: string, input: unknown): void =>
    push(name, input, "CLAUDE_RUNTIME_OBSERVATION_INVALID", MESSAGES.shape);
  const path = (name: string, input: unknown, message: string): void =>
    push(name, input, "CLAUDE_RUNTIME_PATH_INVALID", message);
  const quote = (name: string, input: unknown, message: string): void =>
    push(name, input, "CLAUDE_RUNTIME_QUOTE_INVALID", message);

  shape("the input is null", null);
  shape("the input is text", INSTALLED_ROOT);
  shape("the input is an array", []);
  shape("the input is a function", () => sound());
  shape("the input omits the pin root", { quotedObservation: SOUND_QUOTE, installedRoot: INSTALLED_ROOT });
  // CAPABILITY SMUGGLING, the defect this factory closes. Each of these is a
  // caller trying to supply the runtime authority the package mints privately.
  for (const key of ["fs", "facts", "clock", "process", "deps"]) {
    shape(`the input smuggles a ${key} capability`, sound({ [key]: { observe: () => undefined } }));
  }
  shape(
    "the input answers a field from an accessor",
    Object.defineProperties(
      { installedRoot: INSTALLED_ROOT, pinRoot: PIN_ROOT },
      { quotedObservation: { get: () => SOUND_QUOTE, enumerable: true, configurable: true } },
    ),
  );
  shape(
    "the input hides a field behind a non-enumerable property",
    Object.defineProperties(
      { installedRoot: INSTALLED_ROOT, pinRoot: PIN_ROOT },
      { quotedObservation: { value: SOUND_QUOTE, enumerable: false, configurable: true } },
    ),
  );
  shape("the input inherits a field from a polluted prototype",
    Object.assign(Object.create({ pinRoot: PIN_ROOT }), {
      quotedObservation: SOUND_QUOTE, installedRoot: INSTALLED_ROOT,
    }));
  shape("the input is a thenable", sound({ then: (resolve: (value: unknown) => void) => resolve(1) }));

  // `Array.isArray` THROWS on a revoked proxy, so a validator that asks it first
  // turns hostile input into a crash. A crash is not a refusal.
  const revoked = Proxy.revocable(sound(), {});
  revoked.revoke();
  shape("the input is a revoked proxy", revoked.proxy);
  shape(
    "the input is a proxy whose descriptor trap throws",
    new Proxy(sound(), {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor trap");
      },
    }),
  );

  path("the installed root is not text", sound({ installedRoot: 7 }), MESSAGES.text);
  path("the pin root is a function", sound({ pinRoot: () => PIN_ROOT }), MESSAGES.text);
  path("the installed root is empty", sound({ installedRoot: "" }), MESSAGES.text);
  path("the pin root is oversized", sound({ pinRoot: `C:\\${"a".repeat(500)}` }), MESSAGES.text);
  path("the installed root is relative", sound({ installedRoot: "runtime\\claude" }), MESSAGES.absolute);
  path("the pin root is a UNC share", sound({ pinRoot: "\\\\server\\share\\pins" }), MESSAGES.absolute);
  path("the installed root climbs out of itself", sound({ installedRoot: "C:\\pins\\..\\other" }),
    MESSAGES.relative);
  path("the pin root carries a NUL", sound({ pinRoot: `C:\\pins\u0000\\evil` }), MESSAGES.control);

  quote("the quote is not a record", sound({ quotedObservation: null }), MESSAGES.uncanonical);
  quote("the quote is a function", sound({ quotedObservation: () => SOUND_QUOTE }),
    MESSAGES.uncanonical);
  quote(
    "the quoted digest does not cover the quote",
    sound({ quotedObservation: { ...SOUND_QUOTE, reportedVersion: "9.9.9 (Claude Code)" } }),
    MESSAGES.digest,
  );
  // THE DERIVATION DECISION. `executablePath` is never a public input, because a
  // caller able to name it could point the host observer at a binary the quote
  // never committed to. Zero and two are BOTH refusals: picking the first would
  // let a caller steer the observation by padding the closure.
  quote("the quoted closure declares no EXECUTABLE",
    sound({ quotedObservation: quoteOf([entry("LAUNCHER", LAUNCHER, DIGEST_A)]) }),
    MESSAGES.executable);
  quote("the quoted closure declares two EXECUTABLEs",
    sound({
      quotedObservation: quoteOf([
        entry("EXECUTABLE", EXECUTABLE, DIGEST_A),
        entry("EXECUTABLE", SECOND_EXECUTABLE, DIGEST_B),
      ]),
    }),
    MESSAGES.executable);
  // Bounded BEFORE the quote is hashed: readQuote enforces the same ceiling, but
  // only after canonicalising the whole quote, so an unbounded closure would be
  // digested in full before anything refused it.
  quote("the quoted closure declares more entries than the vocabulary allows", sound({
    quotedObservation: reseal({
      ...SOUND_QUOTE,
      resolvedRuntimeClosure: Array.from({ length: 65 }, (_unused, index) => ({
        kind: "EXECUTABLE", path: `${INSTALLED_ROOT}\\claude-${index}.exe`, sha256: DIGEST_A,
      })),
    }),
  }), MESSAGES.bound);
  quote("the quoted EXECUTABLE carries no text path", sound({
    quotedObservation: reseal({
      ...SOUND_QUOTE,
      resolvedRuntimeClosure: [{ kind: "EXECUTABLE", path: 7, sha256: DIGEST_A }],
    }),
  }), MESSAGES.executablePath);

  // The remaining quote authority is `readQuote`'s, and it answers with its OWN
  // prose: this factory reuses that guard rather than restating it.
  quote("the quote is UNKNOWN",
    sound({ quotedObservation: quoteOf([entry("EXECUTABLE", EXECUTABLE, DIGEST_A)], null) }),
    "an UNKNOWN observation cannot be pinned");
  quote("the quote cannot be pinned by a content-addressed copy",
    sound({ quotedObservation: quoteOf([entry("EXECUTABLE", EXECUTABLE, DIGEST_A)],
      "2.1.233 (Claude Code)", "UNSUPPORTED") }),
    "pinning method \"UNSUPPORTED\" is not a content-addressed copy");

  return Object.freeze(cases);
}

/** Re-digests a tampered observation through the PRODUCTION digest input. */
function reseal(observation: Record<string, unknown>): Record<string, unknown> {
  const body = observationDigestInput(observation as unknown as ProviderRuntimeObservation);
  return { ...observation, observationDigest: canonicalDigest(body) };
}

const CASES = hostileCases();

it("generated a positive number of hostile cases", () => {
  expect(CASES.length, "a sweep that generates zero cases passes while testing nothing")
    .toBeGreaterThan(0);
  expect(CASES.length).toBe(33);
  // Every case pins its exact route. Counted so the pins have to EXIST rather
  // than merely be honoured where they happen to survive.
  expect(CASES.filter((testCase) => testCase.message.length > 0).length).toBe(33);
});

for (const [index, testCase] of CASES.entries()) {
  it(`fails closed when ${testCase.name}`, () => {
    const result = create()(testCase.input) as Record<string, unknown>;
    expect(typeof result, `case ${index}: result is not a record`).toBe("object");
    expect(result["ok"], `case ${index}: a refusal must never report ok`).toBe(false);
    expect(result["code"], `case ${index} refused with the wrong code`).toBe(testCase.code);
    expect(result["layer"], `case ${index} refused at the wrong layer`).toBe(RUNTIME_LAYER);
    expect(result["truthClass"], `case ${index}: a refusal never proves a runtime`).toBe("UNKNOWN");
    expect(CLAUDE_RUNTIME_PIN_ERROR_CODES).toContain(result["code"]);
    // Where two ROUTES share a code, the exact prose is the only thing that says
    // which guard answered.
    expect(result["message"], `case ${index} took the wrong route`).toBe(testCase.message);
    // No capability may escape on a refusal either.
    for (const withheld of ["fs", "facts", "clock"]) {
      expect(result[withheld], `case ${index} leaked a ${withheld} capability`).toBeUndefined();
    }
  });
}

/**
 * The no-echo rail as a PROPERTY over the whole swept set, not a spot check. The
 * producer of the host observer was rejected once on refusal messages echoing
 * runtime paths, and a single example would not have caught it there either.
 */
it("never echoes a path, a digest or a caller value in any refusal message", () => {
  const secrets = [INSTALLED_ROOT, PIN_ROOT, EXECUTABLE, LAUNCHER, SECOND_EXECUTABLE,
    DIGEST_A, DIGEST_B, SCHEMA_DIGEST, SOUND_QUOTE.observationDigest];
  let asserted = 0;
  for (const testCase of CASES) {
    const message = (create()(testCase.input) as Record<string, unknown>)["message"];
    expect(typeof message, `${testCase.name}: refusal carries no message`).toBe("string");
    const text = message as string;
    expect(text.length, `${testCase.name}: refusal message is unbounded`)
      .toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE_CHARS);
    expect(PATH_SHAPED.test(text), `${testCase.name}: message echoes a path: ${text}`).toBe(false);
    for (const secret of secrets) {
      expect(text.includes(secret), `${testCase.name}: message echoes a caller value: ${text}`)
        .toBe(false);
    }
    asserted += 1;
  }
  expect(asserted, "the message property asserted nothing").toBe(CASES.length);
});

function accepted(input: unknown): Record<string, unknown> {
  const result = create()(input) as Record<string, unknown>;
  if (result["ok"] === false) throw new Error(`factory refused: ${String(result["message"])}`);
  return result;
}

it("mints exactly the runtime capabilities the caller may not supply", () => {
  const request = accepted(sound());
  expect(Object.keys(request).sort()).toEqual(
    ["clock", "facts", "fs", "installedRoot", "pinRoot", "quotedObservation"],
  );
  expect(Object.isFrozen(request)).toBe(true);
  expect(typeof (request["fs"] as Record<string, unknown>)["realpath"]).toBe("function");
  expect(typeof (request["fs"] as Record<string, unknown>)["hostPlatform"]).toBe("function");
  expect(typeof (request["facts"] as Record<string, unknown>)["observe"]).toBe("function");
  expect(typeof (request["clock"] as Record<string, unknown>)["observedAt"]).toBe("function");
  expect(request["installedRoot"]).toBe(INSTALLED_ROOT);
  expect(request["pinRoot"]).toBe(PIN_ROOT);
});

it("accepts a null-prototype record, so the boundary is data shape and not identity", () => {
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, sound());
  expect(accepted(bare)["installedRoot"]).toBe(INSTALLED_ROOT);
});

it("keeps a snapshot the caller can no longer reach", () => {
  const mutable = {
    quotedObservation: { ...SOUND_QUOTE, then: (resolve: (v: unknown) => void) => resolve(1) },
    installedRoot: INSTALLED_ROOT,
    pinRoot: PIN_ROOT,
  };
  const request = accepted(mutable);
  const snapshot = request["quotedObservation"] as Record<string, unknown>;
  // A thenable quote is snapshotted into plain data: the `then` never survives.
  expect("then" in snapshot).toBe(false);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot["resolvedRuntimeClosure"])).toBe(true);
  expect(snapshot["observationDigest"]).toBe(SOUND_QUOTE.observationDigest);
  // Mutating what the caller still holds changes nothing that was validated.
  mutable.quotedObservation.reportedVersion = "9.9.9 (Claude Code)";
  mutable.installedRoot = "C:\\elsewhere";
  expect(snapshot["reportedVersion"]).toBe(SOUND_QUOTE.reportedVersion);
  expect(request["installedRoot"]).toBe(INSTALLED_ROOT);
});

/**
 * Module WIDTH. The factory is the only way in; a default port set, a dependency
 * record or an exported filesystem beside it would reopen the seam this closes.
 */
it("publishes nothing beside the factory and its refusal carrier", () => {
  expect(Object.keys(requestModule).sort())
    .toEqual(["ClaudeRuntimeObservationRefused", "createClaudeRuntimePinRequest"]);
});

/* ------------------------------------------------------------------ *
 * The REAL host, through the REAL production preparation.
 *
 * Nothing below injects a filesystem, a facts port, a clock or a process seam —
 * the whole point of the factory is that those cannot be supplied, so a test that
 * reached for one would be testing a shape the production path never takes.
 * ------------------------------------------------------------------ */

const WIN = process.platform === "win32";
const HOST_CASE_TIMEOUT_MS = 60_000;
const roots: string[] = [];

function fixtureRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(nativeJoin(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

/** `where.exe` rather than a hard-coded install path: the host owns where Claude lives. */
function brokerIsBuilt(): boolean {
  return typeof resolveBrokerBinary() === "string";
}

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

function requestFor(
  quotedObservation: unknown,
  installedRoot: string,
  pinRoot: string,
): Record<string, unknown> {
  return accepted({ quotedObservation, installedRoot, pinRoot });
}

/** The exact arm production returned, read off the production result itself. */
function armOf(result: unknown): { readonly code: unknown; readonly layer: unknown } {
  const record = result as Record<string, unknown>;
  return { code: record["code"], layer: typeof record["layer"] === "string" ? record["layer"] : null };
}

/**
 * The observer can refuse from more than one authority, and the port it is
 * wrapped in has no refusal channel — `observe()` returns facts or throws. So the
 * arm is asserted against PRODUCTION'S OWN ANSWER for the same input rather than
 * against a hand-written expectation: a factory that restamped the code, or
 * flattened the layer, disagrees with the observer here and reddens.
 */
it("carries every host-observation arm out of the port with its own code and layer", async () => {
  // `win32.join`, not the native one: the factory only accepts an absolute
  // local-drive Windows path, and off-Windows a posix join turns the absent
  // root into `C:\moe-absent-root/pins`, which the SHAPE guard refuses before
  // the host-observation arm this case exists to assert is ever reached. On
  // win32 the two joins are the same function, so nothing changes there.
  const root = WIN ? fixtureRoot("moe-request-arms-") : "C:\\moe-absent-root";
  const absent = win32.join(root, "claude.exe");
  const notAnImage = win32.join(root, "not-an-image.exe");
  if (WIN) writeFileSync(notAnImage, "not a portable executable");

  const cases = [
    { name: "the quoted executable is not there", executable: absent },
    { name: "the quoted executable is not a loadable image", executable: notAnImage },
  ];
  let asserted = 0;
  for (const testCase of cases) {
    const quote = quoteOf([entry("EXECUTABLE", testCase.executable, DIGEST_A)]);
    const request = requestFor(quote, root, win32.join(root, "pins"));
    const port = request["facts"] as { readonly observe: () => Promise<unknown> };
    const thrown = await port.observe().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown, `${testCase.name}: the port resolved instead of refusing`).not.toBeNull();
    const carried = (thrown as { readonly refusal?: Record<string, unknown> }).refusal;
    expect(typeof carried, `${testCase.name}: the refusal was not carried`).toBe("object");
    const oracle = armOf(
      await observeInstalledClaudeRuntime({ installedRoot: root, executablePath: testCase.executable }),
    );
    expect({ code: carried?.["code"], layer: carried?.["layer"] }, `${testCase.name} lost its arm`)
      .toEqual(oracle);
    expect(carried?.["truthClass"], `${testCase.name} upgraded an UNKNOWN`).toBe("UNKNOWN");
    // Disclosed rather than hidden: off Windows the observer's platform guard
    // answers first, so both cases collapse onto the same arm. The oracle is
    // still production's own answer for the same input, so a factory that
    // restamped the code or flattened the layer reddens on every host.
    const message = (thrown as Error).message;
    expect(PATH_SHAPED.test(message), `${testCase.name}: the throw echoes a path: ${message}`)
      .toBe(false);
    expect(message.includes(testCase.executable)).toBe(false);
    asserted += 1;
  }
  expect(asserted, "the arm sweep asserted nothing").toBe(cases.length);
}, HOST_CASE_TIMEOUT_MS);

it("leaves the runtime UNKNOWN when the host observation refuses", async () => {
  // `win32.join` for the same reason as the arm sweep above: a posix join here
  // reddens on the request SHAPE guard, never reaching the host observation
  // whose UNKNOWN this case is about.
  const root = WIN ? fixtureRoot("moe-request-unknown-") : "C:\\moe-absent-root";
  const quote = quoteOf([entry("EXECUTABLE", win32.join(root, "claude.exe"), DIGEST_A)]);
  const prepared = await prepareClaudeRuntimePin(
    requestFor(quote, root, win32.join(root, "pins")) as never,
  );
  expect(prepared.ok).toBe(false);
  const failure = prepared as unknown as Record<string, unknown>;
  expect(failure["layer"]).toBe(RUNTIME_LAYER);
  expect(failure["truthClass"]).toBe("UNKNOWN");
  // WHICH authority answered is pinned, not merely "some published code". Off
  // Windows the pin's own platform guard refuses BEFORE any host observation
  // runs, so accepting the whole roster there would let this case read as "the
  // observation refused" on a host where the observation never happened.
  if (WIN) expect(CLAUDE_RUNTIME_PIN_ERROR_CODES).toContain(failure["code"]);
  else expect(failure["code"]).toBe("CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED");
}, HOST_CASE_TIMEOUT_MS);

/**
 * DoD 3, on the real host. Both halves are asserted deliberately: a preparation
 * whose fresh observation MATCHED the quote in every field would mean nothing was
 * re-observed, and one that differed in every field would mean the quote was
 * ignored. The quoted digest must match and the pinned binding must not.
 */
it("pins the really installed runtime, or refuses with the host's own stable code", async () => {
  if (!WIN) {
    // Not skipped: a leg that generates zero cases passes while proving nothing.
    const quote = quoteOf([entry("EXECUTABLE", EXECUTABLE, DIGEST_A)]);
    const prepared = await prepareClaudeRuntimePin(
      requestFor(quote, INSTALLED_ROOT, PIN_ROOT) as never,
    );
    expect(armOf(prepared)).toEqual({ code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: RUNTIME_LAYER });
    return;
  }
  const executable = installedClaudeExecutable();
  expect(executable, "no claude.exe on PATH: the pinned arm cannot be certified here").not.toBeNull();
  const installedRoot = realpathSync(dirname(executable as string));
  const observed = await observeInstalledClaudeRuntime({ installedRoot, executablePath: executable as string });
  if (!("ok" in observed && observed.ok === true)) {
    // The ONLY admissible early exit, and it is pinned rather than shrugged at:
    // with the broker built there is nothing left that could refuse here, so a
    // leg that returned early on this host would be proving nothing.
    expect(brokerIsBuilt(), "the broker is built, so the real runtime had to observe").toBe(false);
    expect(armOf(observed).code).toBe("PROCESS_BOUNDARY_BROKER_UNRESOLVED");
    return;
  }
  const quote = observed.observation;
  const pinRoot = fixtureRoot("moe-request-pin-");
  const prepared = await prepareClaudeRuntimePin(requestFor(quote, installedRoot, pinRoot) as never);
  if (!prepared.ok) throw new Error(`preparation refused: ${prepared.code}: ${prepared.message}`);

  expect(prepared.quotedObservationDigest).toBe(quote.observationDigest);
  expect(prepared.freshObservationDigest).not.toBe(quote.observationDigest);
  expect(prepared.observation.observationDigest).toBe(prepared.freshObservationDigest);
  expect(prepared.observation.reportedVersion).toBe(quote.reportedVersion);
  expect(prepared.pinnedRoot.toLowerCase().startsWith(realpathSync(pinRoot).toLowerCase())).toBe(true);
  expect(prepared.executablePath.toLowerCase().startsWith(prepared.pinnedRoot.toLowerCase())).toBe(true);
  expect(prepared.executablePath).not.toBe(executable);
  // REHASHED, not copied on trust: an independent digest of the PINNED bytes must
  // equal the digest the quote declared for the INSTALLED bytes.
  expect(createHash("sha256").update(readFileSync(prepared.executablePath)).digest("hex"))
    .toBe(quote.resolvedRuntimeClosure[0]?.sha256);
}, HOST_CASE_TIMEOUT_MS);

/**
 * Each drift arm separately, and each proving the drift never reached the pinning
 * boundary: `prepareClaudeRuntimePin` creates the pin root only once the quote and
 * the fresh observation have agreed, so an untouched pin root is evidence that
 * nothing a launcher could use was ever produced.
 */
it("refuses byte, version, capability and platform drift before anything is pinned", async () => {
  if (!WIN) {
    const quote = quoteOf([entry("EXECUTABLE", EXECUTABLE, DIGEST_A)]);
    const prepared = await prepareClaudeRuntimePin(
      requestFor(quote, INSTALLED_ROOT, PIN_ROOT) as never,
    );
    expect(armOf(prepared)).toEqual({ code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: RUNTIME_LAYER });
    return;
  }
  const executable = installedClaudeExecutable();
  expect(executable, "no claude.exe on PATH: the drift arms cannot be certified here").not.toBeNull();
  const installedRoot = realpathSync(dirname(executable as string));
  const observed = await observeInstalledClaudeRuntime({
    installedRoot,
    executablePath: executable as string,
  });
  if (!("ok" in observed && observed.ok === true)) {
    expect(typeof armOf(observed).code).toBe("string");
    return;
  }
  const truth = observed.observation as unknown as Record<string, unknown>;
  const closure = truth["resolvedRuntimeClosure"] as readonly Record<string, unknown>[];
  const CHANGED = "the runtime observed now is not the runtime the quote bound";
  const drifts = [
    {
      name: "byte drift",
      quote: reseal({ ...truth, resolvedRuntimeClosure: [{ ...closure[0], sha256: DIGEST_B }] }),
      code: "CLAUDE_RUNTIME_SOURCE_DIGEST_MISMATCH",
      message: null,
    },
    {
      name: "version drift",
      quote: reseal({ ...truth, reportedVersion: "9.9.9 (Claude Code)" }),
      code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
      message: CHANGED,
    },
    {
      name: "capability drift",
      quote: reseal({ ...truth, adapterCapabilitySchemaDigest: SCHEMA_DIGEST }),
      code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
      message: CHANGED,
    },
    {
      name: "platform drift",
      quote: reseal({
        ...truth,
        platformIdentity: { ...(truth["platformIdentity"] as Record<string, unknown>), osVersion: "0.0.1" },
      }),
      code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED",
      message: CHANGED,
    },
  ];
  let asserted = 0;
  for (const drift of drifts) {
    const pinRoot = nativeJoin(fixtureRoot("moe-request-drift-"), "pins");
    const prepared = await prepareClaudeRuntimePin(
      requestFor(drift.quote, installedRoot, pinRoot) as never,
    );
    expect(armOf(prepared), `${drift.name} took the wrong arm`)
      .toEqual({ code: drift.code, layer: RUNTIME_LAYER });
    if (drift.message !== null) {
      expect((prepared as unknown as Record<string, unknown>)["message"],
        `${drift.name} took the wrong route`).toBe(drift.message);
    }
    expect((prepared as unknown as Record<string, unknown>)["truthClass"]).toBe("UNKNOWN");
    // Nothing a launcher could use was produced, and nothing was published.
    expect(existsSync(pinRoot), `${drift.name} reached the pinning boundary`).toBe(false);
    asserted += 1;
  }
  expect(asserted, "the drift sweep asserted nothing").toBe(4);
}, HOST_CASE_TIMEOUT_MS);
