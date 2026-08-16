import { expect, it } from "vitest";

import { canonicalDigest } from "../../canonical.js";
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
  expect(CASES.length).toBe(32);
  // Every case pins its exact route. Counted so the pins have to EXIST rather
  // than merely be honoured where they happen to survive.
  expect(CASES.filter((testCase) => testCase.message.length > 0).length).toBe(32);
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
