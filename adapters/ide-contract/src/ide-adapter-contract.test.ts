import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  type ControlRoomOpenEvidence,
  type DaemonDiscoveryEvidence,
  type DaemonStartEvidence,
  IDE_ADAPTER_LAYER,
  IDE_ADAPTER_LAYERS,
  IDE_ADAPTER_REASON_CODES,
  type IdeAdapterResult,
  decideControlRoomOpen,
  decideDaemonDiscovery,
  decideDaemonStart,
} from "./index.js";

/**
 * Vacuity floor, hand-written. A swept case list that silently produces zero
 * cases passes while testing nothing, so the count is pinned rather than derived.
 */
const MINIMUM_CASES = 17;

/**
 * Evidence arrives from a foreign IDE runtime that does not honour these types.
 * The cast is the point: it reproduces the untyped value a real adapter can hand
 * across the boundary, which is the only way to exercise the total-refusal path.
 */
const foreign = <T>(value: Readonly<Record<string, unknown>>): T => value as unknown as T;

interface ContractCase {
  readonly actual: IdeAdapterResult;
  readonly expected: IdeAdapterResult;
  readonly name: string;
}

const discovery = (evidence: DaemonDiscoveryEvidence): IdeAdapterResult =>
  decideDaemonDiscovery(evidence);
const start = (evidence: DaemonStartEvidence): IdeAdapterResult => decideDaemonStart(evidence);
const open = (evidence: ControlRoomOpenEvidence): IdeAdapterResult => decideControlRoomOpen(evidence);

const CASES: readonly ContractCase[] = [
  {
    actual: discovery({ endpoint: "http://127.0.0.1:9876", status: "LISTENING" }),
    expected: { code: "DAEMON_RUNNING", detail: "http://127.0.0.1:9876", outcome: "OK" },
    name: "discovery reports a listening daemon with its endpoint",
  },
  {
    actual: discovery({ status: "NOT_LISTENING" }),
    expected: { code: "DAEMON_ABSENT", detail: "no daemon is listening", outcome: "OK" },
    name: "discovery reports a determinate absence, which is what licenses a start",
  },
  {
    actual: discovery({ detail: "probe timed out", status: "UNDETERMINED" }),
    expected: {
      code: "DAEMON_STATE_UNKNOWN",
      detail: "probe timed out",
      layer: "DAEMON_DISCOVERY_PORT",
      outcome: "UNKNOWN",
    },
    name: "discovery that cannot determine daemon state is UNKNOWN, never an optimistic success",
  },
  {
    actual: discovery({ detail: "probing is not permitted", status: "REFUSED" }),
    expected: {
      code: "DAEMON_DISCOVERY_REFUSED",
      detail: "probing is not permitted",
      layer: "DAEMON_DISCOVERY_PORT",
      outcome: "REFUSED",
    },
    name: "discovery refused by the port is attributed to the port",
  },
  {
    actual: discovery({ endpoint: null, status: "LISTENING" }),
    expected: {
      code: "DAEMON_ENDPOINT_MISSING",
      detail: "listening was claimed without an endpoint",
      layer: "IDE_ADAPTER",
      outcome: "UNKNOWN",
    },
    name: "discovery claiming LISTENING without an endpoint is refused by the contract, not trusted",
  },
  {
    actual: discovery(foreign<DaemonDiscoveryEvidence>({ status: "PROBABLY_UP" })),
    expected: {
      code: "EVIDENCE_MALFORMED",
      detail: "unrecognised daemon discovery evidence",
      layer: "IDE_ADAPTER",
      outcome: "REFUSED",
    },
    name: "discovery given evidence outside the declared shape fails closed",
  },
  {
    actual: start({ endpoint: "http://127.0.0.1:9876", status: "LISTENING_CONFIRMED" }),
    expected: { code: "DAEMON_STARTED", detail: "http://127.0.0.1:9876", outcome: "OK" },
    name: "start succeeds only once listening was confirmed",
  },
  {
    actual: start({ detail: "spawned pid 4242, never observed listening", status: "LAUNCHED_UNCONFIRMED" }),
    expected: {
      code: "DAEMON_START_UNVERIFIED",
      detail: "spawned pid 4242, never observed listening",
      layer: "IDE_ADAPTER",
      outcome: "UNKNOWN",
    },
    name: "start that launched without confirming listening is UNKNOWN, never DAEMON_STARTED",
  },
  {
    actual: start({ detail: "executable is not on PATH", status: "REFUSED" }),
    expected: {
      code: "DAEMON_START_REFUSED",
      detail: "executable is not on PATH",
      layer: "DAEMON_START_PORT",
      outcome: "REFUSED",
    },
    name: "start refused by the port is attributed to the port",
  },
  {
    actual: start({ endpoint: null, status: "LISTENING_CONFIRMED" }),
    expected: {
      code: "DAEMON_ENDPOINT_MISSING",
      detail: "listening was claimed without an endpoint",
      layer: "IDE_ADAPTER",
      outcome: "UNKNOWN",
    },
    name: "start confirming listening without an endpoint is refused by the contract",
  },
  {
    actual: start(foreign<DaemonStartEvidence>({ status: "MAYBE" })),
    expected: {
      code: "EVIDENCE_MALFORMED",
      detail: "unrecognised daemon start evidence",
      layer: "IDE_ADAPTER",
      outcome: "REFUSED",
    },
    name: "start given evidence outside the declared shape fails closed",
  },
  {
    actual: open({ assets: "PRESENT", embedded: "OPENED" }),
    expected: { code: "CONTROL_ROOM_EMBEDDED", detail: "embedded view opened", outcome: "OK" },
    name: "open succeeds through the embedded view",
  },
  {
    actual: open({
      assets: "PRESENT",
      browser: { detail: "default browser opened", status: "OPENED" },
      embedded: "UNAVAILABLE",
    }),
    expected: {
      code: "CONTROL_ROOM_BROWSER_FALLBACK",
      detail: "default browser opened",
      outcome: "OK",
    },
    name: "an unavailable embedded view falls back to the browser as a SUCCESS, not a failure",
  },
  {
    actual: open({ assets: "ABSENT", detail: "control-room build output is absent" }),
    expected: {
      code: "CONTROL_ROOM_ASSETS_MISSING",
      detail: "control-room build output is absent",
      layer: "CONTROL_ROOM_OPEN_PORT",
      outcome: "REFUSED",
    },
    name: "open without control-room assets is refused and attributed to the port",
  },
  {
    actual: open({
      assets: "PRESENT",
      browser: { detail: "no browser is registered", status: "REFUSED" },
      embedded: "UNAVAILABLE",
    }),
    expected: {
      code: "CONTROL_ROOM_BROWSER_REFUSED",
      detail: "no browser is registered",
      layer: "CONTROL_ROOM_OPEN_PORT",
      outcome: "REFUSED",
    },
    name: "open whose browser fallback is refused is attributed to the port",
  },
  {
    actual: open({
      assets: "PRESENT",
      browser: { detail: "launcher returned no result", status: "UNDETERMINED" },
      embedded: "UNAVAILABLE",
    }),
    expected: {
      code: "CONTROL_ROOM_OPEN_UNKNOWN",
      detail: "launcher returned no result",
      layer: "IDE_ADAPTER",
      outcome: "UNKNOWN",
    },
    name: "open whose browser outcome is undetermined is UNKNOWN, never assumed opened",
  },
  {
    actual: open(foreign<ControlRoomOpenEvidence>({ assets: "SORT_OF" })),
    expected: {
      code: "EVIDENCE_MALFORMED",
      detail: "unrecognised control room open evidence",
      layer: "IDE_ADAPTER",
      outcome: "REFUSED",
    },
    name: "open given evidence outside the declared shape fails closed",
  },
];

it("sweeps a non-zero, pinned number of contract cases", () => {
  expect(CASES.length).toBeGreaterThan(0);
  expect(CASES.length).toBe(MINIMUM_CASES);
  expect(new Set(CASES.map((item) => item.name)).size).toBe(CASES.length);
});

for (const item of CASES) {
  // Each case pins the SPECIFIC code and, on every failure, the refusing layer —
  // asserting the whole result object, so "it did not succeed" can never suffice.
  it(item.name, () => {
    expect(item.actual).toEqual(item.expected);
  });
}

it("produces every declared reason code from the production surface", () => {
  const seen = new Set(CASES.map((item) => item.actual.code));

  // Driven from the frozen exported tuple: dropping an entry makes the exact-length
  // assertion red rather than letting the swept set quietly shrink.
  expect(seen.size).toBeGreaterThan(0);
  expect(seen.size).toBe(IDE_ADAPTER_REASON_CODES.length);
  expect([...seen].sort()).toEqual([...IDE_ADAPTER_REASON_CODES].sort());
});

it("attributes every refusal to a declared layer, and only failures carry one", () => {
  const failures = CASES.filter((item) => item.actual.outcome !== "OK");
  const successes = CASES.filter((item) => item.actual.outcome === "OK");

  expect(failures.length).toBeGreaterThan(0);
  expect(successes.length).toBeGreaterThan(0);
  for (const item of failures) {
    expect(item.actual).toHaveProperty("layer");
    expect(IDE_ADAPTER_LAYERS).toContain(
      (item.actual as Extract<IdeAdapterResult, { layer: string }>).layer,
    );
  }
  for (const item of successes) expect(item.actual).not.toHaveProperty("layer");
});

it("refuses at more than one layer, so a layer assertion cannot be a constant", () => {
  const layers = new Set(
    CASES.filter((item) => item.actual.outcome !== "OK").map(
      (item) => (item.actual as Extract<IdeAdapterResult, { layer: string }>).layer,
    ),
  );

  expect(layers.size).toBeGreaterThan(1);
  expect(layers).toContain(IDE_ADAPTER_LAYER);
  expect(layers).toContain("DAEMON_DISCOVERY_PORT");
});

it("freezes the reason-code and layer vocabularies without duplicates", () => {
  expect(Object.isFrozen(IDE_ADAPTER_REASON_CODES)).toBe(true);
  expect(Object.isFrozen(IDE_ADAPTER_LAYERS)).toBe(true);
  expect(new Set(IDE_ADAPTER_REASON_CODES).size).toBe(IDE_ADAPTER_REASON_CODES.length);
  expect(new Set(IDE_ADAPTER_LAYERS).size).toBe(IDE_ADAPTER_LAYERS.length);
  expect(IDE_ADAPTER_LAYERS).toContain(IDE_ADAPTER_LAYER);
});

/** Resolved from the module URL, never process.cwd() — vitest runs rooted at the repository. */
const SELF = fileURLToPath(import.meta.url);
const OWNED_ROOT = resolve(dirname(SELF), "..");
const SELF_NAME = basename(SELF);
/**
 * Vacuity floor, hand-written. A mis-resolved readdir scanning zero files reports
 * zero matches and passes, which reads exactly like a clean sweep.
 */
const MINIMUM_SCANNED_FILES = 5;
/** Case-insensitive. This file necessarily matches them, hence the self-exclusion below. */
const EDITOR_IDENTIFIERS = Object.freeze(["jetbrains", "intellij", "vscode"] as const);

const walkOwned = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules") return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walkOwned(path) : [path];
  });

const ownedName = (file: string): string => relative(OWNED_ROOT, file).split("\\").join("/");

it("contains no editor-specific identifier anywhere in the owned deliverable", () => {
  const discovered = walkOwned(OWNED_ROOT);
  const scanned = discovered.filter((file) => basename(file) !== SELF_NAME);

  // Scoped to owned paths only: a repo-wide sweep hits pre-existing foreign files
  // this task does not own, and would fail for reasons it cannot fix.
  expect(discovered.map(ownedName)).toContain(`src/${SELF_NAME}`);
  // The scanner matches its own bytes because it must spell the search terms out.
  // Excluding it is required; asserting the exclusion HAPPENED is what stops a
  // rename from quietly turning this guard into a tautology.
  expect(scanned.map(ownedName)).not.toContain(`src/${SELF_NAME}`);
  expect(scanned.length).toBe(discovered.length - 1);
  expect(scanned.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);

  const offenders = scanned.flatMap((file) => {
    const contents = readFileSync(file, "utf8").toLowerCase();
    return EDITOR_IDENTIFIERS.filter((term) => contents.includes(term)).map(
      (term) => `${ownedName(file)}: ${term}`,
    );
  });

  expect(offenders).toEqual([]);
});

it("proves the neutrality sweep can actually detect an identifier", () => {
  // Negative control. Without it, `offenders` being empty is equally consistent
  // with a sweep that reads nothing, and the guard above would be unfalsifiable.
  const planted = `const owner = "JetBrains";`.toLowerCase();

  expect(EDITOR_IDENTIFIERS.filter((term) => planted.includes(term))).toEqual(["jetbrains"]);
  expect(readFileSync(SELF, "utf8").toLowerCase()).toContain("jetbrains");
});
