/**
 * The discovery capability's contract, and its whole job is to be UNSTEERABLE.
 *
 * `observeInstalledClaudeRuntime` stays internal because it takes an
 * `executablePath`: a consumer holding it could point the host observer at a
 * binary no quote ever committed to. Discovery closes the other half of that
 * asymmetry — it answers an observation of THE installed runtime while giving the
 * caller no way to say WHICH runtime gets observed.
 *
 * The tests below manipulate the HOST's own configuration (its search path, its
 * home directory) rather than any parameter, because that is the only lever a
 * caller has left. Refusing ambiguity is what makes that lever useless.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { delimiter, join as nativeJoin, win32 } from "node:path";

import { afterAll, afterEach, expect, it } from "vitest";

import {
  buildProviderRuntimeObservation,
  type ProviderRuntimeObservation,
} from "./claude-observation.js";
import {
  discoverInstalledClaudeRuntime,
  type DiscoverInstalledClaudeRuntimeResult,
} from "./claude-runtime-discovery.js";
import { prepareClaudeRuntimePin } from "./claude-runtime-pin.js";
import { createClaudeRuntimePinRequest } from "./claude-runtime-request.js";

/** A real, tiny, genuinely runnable executable that is NOT the Claude runtime. */
const STAND_IN_SOURCE = "C:\\Windows\\System32\\where.exe";
const ON_WINDOWS = process.platform === "win32";
const temporaries: string[] = [];
const savedPath = process.env["PATH"];
const savedProfile = process.env["USERPROFILE"];

afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = savedProfile;
});

afterAll(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(label: string): string {
  const created = mkdtempSync(nativeJoin(tmpdir(), `moe-${label}-`));
  temporaries.push(created);
  return created;
}

/** A directory holding one stand-in `claude.exe`, returned as its own PATH entry. */
function standInDirectory(label: string): string {
  const directory = temporaryDirectory(label);
  copyFileSync(STAND_IN_SOURCE, win32.join(directory, "claude.exe"));
  return directory;
}

/**
 * Rewrites the host's own configuration. Nothing here is a parameter of the
 * capability under test — that is the point. `USERPROFILE` is redirected at an
 * empty directory so the platform's known install location contributes nothing
 * a test did not put there.
 */
function hostSearchPath(entries: readonly string[], home?: string): void {
  process.env["PATH"] = entries.join(delimiter);
  process.env["USERPROFILE"] = home ?? temporaryDirectory("empty-home");
}

interface Answer {
  readonly kind: "OBSERVED" | "REFUSED";
  readonly detail: string;
}

/** Collapses either arm into one comparable value, so a steered call cannot hide. */
function answerOf(result: DiscoverInstalledClaudeRuntimeResult): Answer {
  if ("ok" in result && result.ok === true) {
    const entry = result.observation.resolvedRuntimeClosure[0];
    return { kind: "OBSERVED", detail: entry === undefined ? "<none>" : entry.path };
  }
  const layer = (result as { readonly layer?: unknown }).layer;
  return {
    kind: "REFUSED",
    detail: `${(result as { readonly code: string }).code}@${typeof layer === "string" ? layer : "<none>"}`,
  };
}

function refusalOf(result: DiscoverInstalledClaudeRuntimeResult): {
  readonly code: string;
  readonly layer: unknown;
  readonly truthClass: unknown;
  readonly message: string;
} {
  if ("ok" in result && result.ok === true) {
    throw new Error("expected a refusal, discovery answered an observation");
  }
  const record = result as {
    readonly code: string; readonly layer?: unknown;
    readonly truthClass?: unknown; readonly message: string;
  };
  return {
    code: record.code, layer: record.layer,
    truthClass: record.truthClass, message: record.message,
  };
}

/**
 * A TYPE-LEVEL fact, not a runtime check. The runner tsconfig includes
 * `src/**` + `/*.ts`, so `pnpm --filter @moe/runner typecheck` enforces this file:
 * adding a parameter — required, optional or defaulted — makes `Parameters<>`
 * stop being the empty tuple and the assignment below stops compiling. A runtime
 * rejection would be one refactor away from being relaxed; an absent parameter
 * is not.
 */
type TakesNoArgument =
  Parameters<typeof discoverInstalledClaudeRuntime> extends readonly [] ? true : false;

it("takes no parameter through which a caller could name a binary, an fs, a facts port or a clock", () => {
  const unsteerable: TakesNoArgument = true;
  expect(unsteerable).toBe(true);
  // Kills the plain optional parameter at runtime too: `executablePath?: string`
  // emits a declared parameter, so arity stops being zero.
  expect(discoverInstalledClaudeRuntime.length).toBe(0);
});

it("answers the same runtime whether or not a caller passes a steering argument", async () => {
  const steer = ON_WINDOWS ? win32.join(standInDirectory("steer"), "claude.exe") : "/usr/bin/claude";
  const plain = await discoverInstalledClaudeRuntime();
  const steered = await (
    discoverInstalledClaudeRuntime as unknown as
      (path: string) => Promise<DiscoverInstalledClaudeRuntimeResult>
  )(steer);
  expect(answerOf(steered)).toEqual(answerOf(plain));
});

it("refuses a host on which no claude runtime resolves, with CLAUDE_RUNTIME_PATH_MISSING at RUNTIME", async () => {
  hostSearchPath([temporaryDirectory("no-runtime")]);
  const refusal = refusalOf(await discoverInstalledClaudeRuntime());
  expect({ code: refusal.code, layer: refusal.layer, truthClass: refusal.truthClass }).toEqual(
    ON_WINDOWS
      ? { code: "CLAUDE_RUNTIME_PATH_MISSING", layer: "RUNTIME", truthClass: "UNKNOWN" }
      : { code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: "RUNTIME", truthClass: "UNKNOWN" },
  );
});

it("refuses more than one resolved candidate rather than picking one, with CLAUDE_RUNTIME_PATH_DUPLICATE at RUNTIME", async () => {
  hostSearchPath([standInDirectory("first"), standInDirectory("second")]);
  const refusal = refusalOf(await discoverInstalledClaudeRuntime());
  expect({ code: refusal.code, layer: refusal.layer, truthClass: refusal.truthClass }).toEqual(
    ON_WINDOWS
      ? { code: "CLAUDE_RUNTIME_PATH_DUPLICATE", layer: "RUNTIME", truthClass: "UNKNOWN" }
      : { code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: "RUNTIME", truthClass: "UNKNOWN" },
  );
});

it("counts one binary reachable by two search entries as one candidate, not an ambiguity", async () => {
  const directory = ON_WINDOWS ? standInDirectory("deduped") : temporaryDirectory("deduped");
  hostSearchPath([directory, directory]);
  const refusal = refusalOf(await discoverInstalledClaudeRuntime());
  // The OBSERVER answered, which can only happen after resolution settled on
  // exactly one candidate. A duplicate refusal here would mean de-duplication
  // never ran; a missing refusal would mean the entry was not found at all.
  expect(refusal.code).toBe(
    ON_WINDOWS ? "CLAUDE_RUNTIME_OBSERVATION_INVALID" : "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
  );
});

it("passes an observer refusal through with the exact code and layer of the authority that answered", async () => {
  hostSearchPath([ON_WINDOWS ? standInDirectory("stand-in") : temporaryDirectory("stand-in")]);
  const refusal = refusalOf(await discoverInstalledClaudeRuntime());
  // Measured on this host: the shipped broker really creates the process and the
  // stand-in exits non-zero for `--version`, so the RUNTIME layer refuses. Not a
  // discovery code — restamping would erase which of four authorities answered.
  expect({ code: refusal.code, layer: refusal.layer }).toEqual(
    ON_WINDOWS
      ? { code: "CLAUDE_RUNTIME_OBSERVATION_INVALID", layer: "RUNTIME" }
      : { code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED", layer: "RUNTIME" },
  );
});

it("keeps every discovery refusal free of the paths, arguments and environment it searched", async () => {
  const directory = temporaryDirectory("hygiene");
  hostSearchPath([directory]);
  const messages = [refusalOf(await discoverInstalledClaudeRuntime()).message];
  if (ON_WINDOWS) {
    hostSearchPath([standInDirectory("hygiene-a"), standInDirectory("hygiene-b")]);
    messages.push(refusalOf(await discoverInstalledClaudeRuntime()).message);
  }
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    expect(message).not.toMatch(/[\\]|[A-Za-z]:|claude\.exe|AppData|Temp|PATH|USERPROFILE/u);
    expect(message.length).toBeGreaterThan(0);
  }
});

/* ------------------------------------------------------------------ *
 * DoD 2: the real-Windows round trip, and the two negatives that must
 * survive it. A rebuilt digest would prove nothing here — the point is that
 * discovery is the ONLY route to a quote pinning accepts.
 * ------------------------------------------------------------------ */

/** Exactly what `factsDigest` compares; pinned closure paths legitimately differ. */
function comparedFacts(observation: ProviderRuntimeObservation): Record<string, unknown> {
  return {
    reportedVersion: observation.reportedVersion,
    adapterCapabilitySchemaDigest: observation.adapterCapabilitySchemaDigest,
    os: observation.platformIdentity.os,
    arch: observation.platformIdentity.arch,
    osVersion: observation.platformIdentity.osVersion,
  };
}

it("reaches a PROVEN pin against the really installed runtime through discovery alone", async () => {
  const discovered = await discoverInstalledClaudeRuntime();
  if (!ON_WINDOWS) {
    expect(refusalOf(discovered).code).toBe("CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED");
    return;
  }
  if (!("ok" in discovered && discovered.ok === true)) {
    throw new Error(`discovery refused with ${refusalOf(discovered).code}`);
  }
  const quoted = discovered.observation;
  // A real launch produced this: nothing in this file computes a capability
  // digest or parses a version, and no other production surface can mint either.
  expect(quoted.truthClass).toBe("PROVEN");
  expect(quoted.reportedVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?(?:\s+\(.{1,100}\))?$/u);
  expect(quoted.adapterCapabilitySchemaDigest).toMatch(/^[0-9a-f]{64}$/u);

  const pinRoot = temporaryDirectory("pin-root");
  const hydrated = createClaudeRuntimePinRequest({
    quotedObservation: quoted, installedRoot: discovered.installedRoot, pinRoot,
  });
  if ("ok" in hydrated) throw new Error(`hydration refused with ${hydrated.code}`);
  const prepared = await prepareClaudeRuntimePin(hydrated);
  if (prepared.ok !== true) throw new Error(`${prepared.code}: ${prepared.message}`);

  expect(prepared.observation.truthClass).toBe("PROVEN");
  expect(comparedFacts(prepared.observation)).toEqual(comparedFacts(quoted));
  expect(prepared.quotedObservationDigest).toBe(quoted.observationDigest);
  // The pinned closure is a CONTENT-ADDRESSED COPY, so its path must differ from
  // the installed one. Whole-object equality would fail on this legitimate
  // difference and then get "fixed" by loosening the assertion that matters.
  expect(prepared.executablePath).not.toBe(discovered.observation.resolvedRuntimeClosure[0]?.path);
}, 600_000);

it("still refuses a self-assembled quote no production observation minted, with CLAUDE_RUNTIME_OBSERVATION_CHANGED at RUNTIME", async () => {
  const discovered = await discoverInstalledClaudeRuntime();
  if (!ON_WINDOWS || !("ok" in discovered && discovered.ok === true)) {
    expect(refusalOf(discovered).truthClass).toBe("UNKNOWN");
    return;
  }
  const executablePath = discovered.observation.resolvedRuntimeClosure[0]?.path ?? "";
  // TRUE closure, TRUE sha256, TRUE platform identity — and a version and
  // capability digest this test made up, which is exactly what a caller can do.
  const forged = buildProviderRuntimeObservation({
    resolvedRuntimeClosure: [{
      kind: "EXECUTABLE", path: executablePath,
      sha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
    }],
    reportedVersion: "9.9.9 (Claude Code)",
    adapterCapabilitySchemaDigest: "c".repeat(64),
    pinningMethod: "CONTENT_ADDRESSED_COPY",
    platformIdentity: { os: "win32", arch: arch(), osVersion: release() },
    clock: { observedAt: () => new Date().toISOString() },
  });
  if (!forged.ok) throw new Error(`the forged quote did not build: ${forged.code}`);
  const pinRoot = temporaryDirectory("forged-pin-root");
  const hydrated = createClaudeRuntimePinRequest({
    quotedObservation: forged.observation, installedRoot: discovered.installedRoot, pinRoot,
  });
  if ("ok" in hydrated) throw new Error(`hydration refused with ${hydrated.code}`);
  const prepared = await prepareClaudeRuntimePin(hydrated);
  if (prepared.ok === true) throw new Error("a self-assembled quote reached a PROVEN pin");
  expect({ code: prepared.code, layer: prepared.layer, truth: prepared.truthClass }).toEqual({
    code: "CLAUDE_RUNTIME_OBSERVATION_CHANGED", layer: "RUNTIME", truth: "UNKNOWN",
  });
}, 600_000);

it("keeps the stand-in binary refused after the shipped broker really probed it", async () => {
  if (!ON_WINDOWS) {
    hostSearchPath([temporaryDirectory("stand-in-off-windows")]);
    expect(refusalOf(await discoverInstalledClaudeRuntime()).code)
      .toBe("CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED");
    return;
  }
  const directory = standInDirectory("probed-stand-in");
  mkdirSync(win32.join(directory, "unused"), { recursive: true });
  hostSearchPath([directory]);
  const refusal = refusalOf(await discoverInstalledClaudeRuntime());
  expect({ code: refusal.code, layer: refusal.layer }).toEqual({
    code: "CLAUDE_RUNTIME_OBSERVATION_INVALID", layer: "RUNTIME",
  });
}, 120_000);
