import {
  DISTRIBUTION_MANIFEST_VERSION,
  DISTRIBUTION_SIGNATURE_ALGORITHM,
} from "@moe/contracts";
import type {
  DistributionApiRange,
  DistributionComponentKind,
  DistributionManifest,
} from "@moe/contracts";
import { IDE_ADAPTER_REASON_CODES } from "@moe/ide-adapter-contract";
import type {
  ControlRoomOpenEvidence,
  DaemonDiscoveryEvidence,
  DaemonStartEvidence,
  IdeAdapterReasonCode,
} from "@moe/ide-adapter-contract";
import { expect, it } from "vitest";

import {
  JETBRAINS_REQUIRED_COMPONENT_KINDS,
  admitDistribution,
  createJetBrainsSession,
} from "./index.js";
import type { JetBrainsPorts, JetBrainsResult } from "./index.js";

/**
 * Every port here is a FAKE that returns injected evidence. Nothing spawns a
 * process, launches a browser or opens a socket: the adapter under test is a
 * decision sequencer, and a suite that needed a real daemon would be testing
 * the host, not the adapter.
 */

const API_RANGE: DistributionApiRange = Object.freeze({
  commandEnvelopeVersion: "moe-command-envelope/1",
  errorRegistryVersion: "moe-error-registry/1",
  queryEnvelopeVersion: "moe-query-envelope/1",
});

const manifestOf = (
  componentKind: DistributionComponentKind,
  overrides: Partial<DistributionManifest> = {},
): DistributionManifest => ({
  aggregateDigest: "a".repeat(64),
  apiCompatibilityRange: API_RANGE,
  assets: [],
  buildToolVersions: { node: "24.0.0" },
  builtInSkills: [],
  componentId: `${componentKind.toLowerCase()}-1`,
  componentKind,
  contractSchemaHash: "b".repeat(64),
  instructionTemplates: [],
  manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
  signatureAlgorithm: DISTRIBUTION_SIGNATURE_ALGORITHM,
  signingKeyId: "key-1",
  source: { objectFormat: "sha1", sourceSha: "c".repeat(40) },
  ...overrides,
});

/** The admissible pair: exactly the kinds the adapter declares it cannot run without. */
const COMPATIBLE = (): readonly DistributionManifest[] =>
  [manifestOf("DAEMON"), manifestOf("CONTROL_ROOM")];

interface Calls {
  discoverDistributions: number;
  openControlRoom: number;
  probeDaemon: number;
  startDaemon: number;
}

interface Harness {
  readonly calls: Calls;
  readonly ports: JetBrainsPorts;
}

type Thrower = { readonly throws: Error };

const isThrower = (value: unknown): value is Thrower =>
  typeof value === "object" && value !== null && "throws" in value;

interface HarnessInput {
  readonly controlRoom?: ControlRoomOpenEvidence | Thrower;
  readonly discovery?: DaemonDiscoveryEvidence | Thrower;
  readonly distributions?: readonly DistributionManifest[] | Thrower | unknown;
  readonly start?: DaemonStartEvidence | Thrower;
}

const RUNNING: DaemonDiscoveryEvidence = { endpoint: "http://127.0.0.1:9876", status: "LISTENING" };
const ABSENT: DaemonDiscoveryEvidence = { status: "NOT_LISTENING" };
const STARTED: DaemonStartEvidence = {
  endpoint: "http://127.0.0.1:9876",
  status: "LISTENING_CONFIRMED",
};
const EMBEDDED: ControlRoomOpenEvidence = { assets: "PRESENT", embedded: "OPENED" };
const FALLBACK: ControlRoomOpenEvidence = {
  assets: "PRESENT",
  browser: { detail: "opened in the default browser", status: "OPENED" },
  embedded: "UNAVAILABLE",
};

/**
 * Counts every port invocation. Reconnect and uninstall are both proven by a
 * port NOT firing, so the count is the assertion subject, not a convenience.
 */
const harness = (input: HarnessInput = {}): Harness => {
  const calls: Calls = {
    discoverDistributions: 0,
    openControlRoom: 0,
    probeDaemon: 0,
    startDaemon: 0,
  };
  const yielded = <T>(value: T | Thrower | undefined, fallback: T): T => {
    if (isThrower(value)) throw value.throws;
    return value === undefined ? fallback : value;
  };
  const ports: JetBrainsPorts = {
    controlRoom: {
      openControlRoom: async () => {
        calls.openControlRoom += 1;
        return yielded(input.controlRoom, EMBEDDED);
      },
    },
    discovery: {
      probeDaemon: async () => {
        calls.probeDaemon += 1;
        return yielded(input.discovery, RUNNING);
      },
    },
    distribution: {
      discoverDistributions: async () => {
        calls.discoverDistributions += 1;
        return yielded(
          input.distributions as readonly DistributionManifest[] | Thrower | undefined,
          COMPATIBLE(),
        );
      },
    },
    start: {
      startDaemon: async () => {
        calls.startDaemon += 1;
        return yielded(input.start, STARTED);
      },
    },
  };
  return { calls, ports };
};

const openWith = async (input: HarnessInput = {}): Promise<JetBrainsResult> => {
  const { ports } = harness(input);
  return createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE }).openControlRoom();
};

// ---------------------------------------------------------------------------
// DoD 3 — the six named cases. Each pins the EXACT code and the refusing layer.
// ---------------------------------------------------------------------------

it("START: an absent daemon is started and the control room opens", async () => {
  const { calls, ports } = harness({ controlRoom: EMBEDDED, discovery: ABSENT, start: STARTED });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  expect(await session.openControlRoom()).toEqual({
    code: "CONTROL_ROOM_EMBEDDED",
    detail: "embedded view opened",
    outcome: "OK",
  });
  // The start port fired exactly once: DAEMON_ABSENT is what licenses a start.
  expect(calls.startDaemon).toBe(1);
});

it("START: a confirmed listening daemon reports DAEMON_STARTED with its endpoint", async () => {
  const { ports } = harness({ discovery: ABSENT, start: STARTED });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });
  await session.openControlRoom();

  expect(session.startOutcome()).toEqual({
    code: "DAEMON_STARTED",
    detail: "http://127.0.0.1:9876",
    outcome: "OK",
  });
});

it("EMBED: assets present and embedding available yields CONTROL_ROOM_EMBEDDED", async () => {
  expect(await openWith({ controlRoom: EMBEDDED })).toEqual({
    code: "CONTROL_ROOM_EMBEDDED",
    detail: "embedded view opened",
    outcome: "OK",
  });
});

it("BROWSER FALLBACK: unavailable embedding is a SUCCESS, not a failure", async () => {
  const result = await openWith({ controlRoom: FALLBACK });

  // outcome OK is the whole point: an adapter that models fallback as a failure
  // refuses on every host without an embedded view.
  expect(result).toEqual({
    code: "CONTROL_ROOM_BROWSER_FALLBACK",
    detail: "opened in the default browser",
    outcome: "OK",
  });
  expect("layer" in result).toBe(false);
});

it("RECONNECT: a running daemon is reused and the start port is NEVER called", async () => {
  const { calls, ports } = harness({ discovery: RUNNING });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  expect(await session.openControlRoom()).toEqual({
    code: "CONTROL_ROOM_EMBEDDED",
    detail: "embedded view opened",
    outcome: "OK",
  });
  // Reconnect is proven by ABSENCE. Asserting DAEMON_RUNNING alone would pass
  // even if a second daemon had been started beside the first.
  expect(calls.startDaemon).toBe(0);
  expect(calls.probeDaemon).toBe(1);
  expect(session.discoveryOutcome()).toEqual({
    code: "DAEMON_RUNNING",
    detail: "http://127.0.0.1:9876",
    outcome: "OK",
  });
});

it("UNINSTALL: teardown drops the handle and a later action refuses without touching a port",
  async () => {
    const { calls, ports } = harness({ discovery: RUNNING });
    const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });
    await session.openControlRoom();
    expect(session.endpoint()).toBe("http://127.0.0.1:9876");

    session.uninstall();
    expect(session.endpoint()).toBeNull();
    const after = await session.openControlRoom();

    expect(after).toEqual({
      code: "DAEMON_STATE_UNKNOWN",
      detail: "the session was uninstalled; no live handle remains",
      layer: "IDE_ADAPTER",
      outcome: "UNKNOWN",
    });
    // Silently reopening is the failure this case exists to catch: no port may
    // fire again, so every counter stays at its pre-uninstall value.
    expect(calls).toEqual({
      discoverDistributions: 1,
      openControlRoom: 1,
      probeDaemon: 1,
      startDaemon: 0,
    });
  });

it("MISMATCH: an incompatible API range fails closed in the distribution vocabulary", async () => {
  const stale = manifestOf("DAEMON", {
    apiCompatibilityRange: { ...API_RANGE, commandEnvelopeVersion: "moe-command-envelope/0" },
  });
  const { calls, ports } = harness({ distributions: [stale, manifestOf("CONTROL_ROOM")] });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  expect(await session.openControlRoom()).toEqual({
    code: "DISTRIBUTION_MISMATCH",
    ok: false,
    reason: "API_RANGE_MISMATCH",
    refusedBy: "DISTRIBUTION_STARTUP",
  });
  // The gate runs BEFORE discovery: an incompatible pair must never reach the
  // daemon at all, so a mismatch that still probed would be a fail-open.
  expect(calls.probeDaemon).toBe(0);
  expect(calls.startDaemon).toBe(0);
  expect(calls.openControlRoom).toBe(0);
});

// ---------------------------------------------------------------------------
// DoD 1 — one fixture per gate leg. Each fixture is deliberately VALID at every
// earlier leg, otherwise an earlier guard answers first and the leg under test
// is never reached while its case still reads as covered.
// ---------------------------------------------------------------------------

const gateLegs: ReadonlyArray<{
  readonly distributions: unknown;
  readonly name: string;
  readonly reason: string;
}> = [
  {
    distributions: "not-an-array",
    name: "evidence that is not a manifest list",
    reason: "MANIFEST_SCHEMA_INVALID",
  },
  {
    distributions: [manifestOf("DAEMON"), { componentKind: "CONTROL_ROOM" }],
    name: "a manifest missing required fields",
    reason: "MANIFEST_SCHEMA_INVALID",
  },
  {
    distributions: [
      manifestOf("DAEMON", { manifestVersion: "moe-distribution-manifest/0" as never }),
      manifestOf("CONTROL_ROOM"),
    ],
    name: "an unsupported manifest version",
    reason: "MANIFEST_VERSION_UNSUPPORTED",
  },
  {
    distributions: [
      manifestOf("DAEMON", { componentKind: "TELEMETRY" as never }),
      manifestOf("CONTROL_ROOM"),
    ],
    name: "a component kind outside the frozen set",
    reason: "COMPONENT_KIND_MISMATCH",
  },
  {
    distributions: [manifestOf("DAEMON"), manifestOf("DAEMON"), manifestOf("CONTROL_ROOM")],
    name: "two components claiming the same required kind",
    reason: "COMPONENT_DUPLICATE",
  },
  {
    distributions: [manifestOf("DAEMON")],
    name: "a required component kind absent from the set",
    reason: "COMPONENT_SET_INCOMPLETE",
  },
  {
    distributions: [],
    name: "an empty distribution set",
    reason: "COMPONENT_SET_INCOMPLETE",
  },
  {
    distributions: [
      manifestOf("DAEMON", { apiCompatibilityRange: {} as never }),
      manifestOf("CONTROL_ROOM"),
    ],
    name: "a manifest whose API range is empty rather than absent",
    reason: "MANIFEST_SCHEMA_INVALID",
  },
];

it("generates a distribution gate case for every leg", () => {
  // A sweep that silently produces zero cases passes while testing nothing.
  expect(gateLegs.length).toBe(8);
  expect(new Set(gateLegs.map((leg) => leg.reason)).size).toBe(5);
});

for (const leg of gateLegs) {
  it(`MISMATCH: ${leg.name} refuses with ${leg.reason}`, async () => {
    const { calls, ports } = harness({ distributions: leg.distributions });
    const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

    expect(await session.openControlRoom()).toEqual({
      code: "DISTRIBUTION_MISMATCH",
      ok: false,
      reason: leg.reason,
      refusedBy: "DISTRIBUTION_STARTUP",
    });
    expect(calls.probeDaemon).toBe(0);
  });
}

it("declares the component kinds it cannot run without, drawn from the frozen kind set",
  () => {
    expect(JETBRAINS_REQUIRED_COMPONENT_KINDS).toEqual(["CONTROL_ROOM", "DAEMON"]);
    expect(Object.isFrozen(JETBRAINS_REQUIRED_COMPONENT_KINDS)).toBe(true);
  });

const badExpectations: ReadonlyArray<{ readonly name: string; readonly value: unknown }> = [
  { name: "an absent expectation", value: undefined },
  { name: "an expectation with no range at all", value: {} },
  { name: "an expectation whose range is empty", value: { apiCompatibilityRange: {} } },
  {
    name: "an expectation missing one range field",
    value: {
      apiCompatibilityRange: {
        commandEnvelopeVersion: "moe-command-envelope/1",
        errorRegistryVersion: "moe-error-registry/1",
      },
    },
  },
  {
    name: "an expectation whose range field is blank",
    value: { apiCompatibilityRange: { ...API_RANGE, queryEnvelopeVersion: "  " } },
  },
];

it("generates an unusable-expectation case for every shape", () => {
  expect(badExpectations.length).toBe(5);
});

for (const bad of badExpectations) {
  it(`refuses ${bad.name} instead of comparing against it`, () => {
    // Two empty ranges compare EQUAL, so an unvalidated expectation admits every
    // distribution while the comparison still runs. That is the fail-open this
    // pins: the refusal must arrive BEFORE any manifest is looked at.
    expect(admitDistribution([manifestOf("DAEMON"), manifestOf("CONTROL_ROOM")], bad.value))
      .toEqual({
        code: "DISTRIBUTION_MISMATCH",
        ok: false,
        reason: "EXPECTATION_INVALID",
        refusedBy: "DISTRIBUTION_STARTUP",
      });
  });
}

it("admits a compatible pair, so the gate is not refusing everything", () => {
  // Without this, every refusal assertion above would pass on a gate that never
  // admits anything at all.
  expect(admitDistribution(COMPATIBLE(), { apiCompatibilityRange: API_RANGE })).toBeNull();
});

// ---------------------------------------------------------------------------
// Concurrency and teardown races. An IDE fires open twice routinely.
// ---------------------------------------------------------------------------

it("starts only ONE daemon when two opens race", async () => {
  const { calls, ports } = harness({ discovery: ABSENT, start: STARTED });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  const [first, second] = await Promise.all([
    session.openControlRoom(),
    session.openControlRoom(),
  ]);

  // Both callers get an answer, but the daemon is started once. Two concurrent
  // runs would each observe DAEMON_ABSENT and each start one.
  expect(calls.startDaemon).toBe(1);
  expect(calls.probeDaemon).toBe(1);
  expect(calls.openControlRoom).toBe(1);
  expect(first).toEqual(second);
});

it("does not resurrect the handle when uninstall lands mid-flight", async () => {
  const { calls, ports } = harness({ discovery: RUNNING });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  const flight = session.openControlRoom();
  session.uninstall();
  const result = await flight;

  // Every state write in the run happens after an await, so a run that ignored
  // the teardown would set endpoint back to a live value after uninstall.
  expect(session.endpoint()).toBeNull();
  expect(result).toEqual({
    code: "DAEMON_STATE_UNKNOWN",
    detail: "the session was uninstalled; no live handle remains",
    layer: "IDE_ADAPTER",
    outcome: "UNKNOWN",
  });
  expect(calls.openControlRoom).toBe(0);
});

// ---------------------------------------------------------------------------
// Fail-closed: unverifiable evidence never becomes success, and a throwing port
// becomes a typed failure at THAT port's layer rather than an escaping error.
// ---------------------------------------------------------------------------

it("a launched-but-unconfirmed daemon is UNKNOWN, never a success", async () => {
  const result = await openWith({
    discovery: ABSENT,
    start: { detail: "no listener answered", status: "LAUNCHED_UNCONFIRMED" },
  });

  expect(result).toEqual({
    code: "DAEMON_START_UNVERIFIED",
    detail: "no listener answered",
    layer: "IDE_ADAPTER",
    outcome: "UNKNOWN",
  });
});

it("stops after an unverified start rather than opening the control room anyway", async () => {
  const { calls, ports } = harness({
    discovery: ABSENT,
    start: { detail: "no listener answered", status: "LAUNCHED_UNCONFIRMED" },
  });
  await createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE }).openControlRoom();

  expect(calls.openControlRoom).toBe(0);
});

const throwingPorts: ReadonlyArray<{
  readonly code: IdeAdapterReasonCode;
  readonly input: HarnessInput;
  readonly layer: string;
  readonly port: string;
}> = [
  {
    code: "DAEMON_STATE_UNKNOWN",
    input: { discovery: { throws: new Error("probe exploded") } },
    layer: "DAEMON_DISCOVERY_PORT",
    port: "probeDaemon",
  },
  {
    code: "DAEMON_START_UNVERIFIED",
    input: { discovery: ABSENT, start: { throws: new Error("spawn exploded") } },
    layer: "DAEMON_START_PORT",
    port: "startDaemon",
  },
  {
    code: "CONTROL_ROOM_OPEN_UNKNOWN",
    input: { controlRoom: { throws: new Error("open exploded") } },
    layer: "CONTROL_ROOM_OPEN_PORT",
    port: "openControlRoom",
  },
];

it("generates a throwing-port case for every IDE port", () => {
  expect(throwingPorts.length).toBe(3);
  expect(new Set(throwingPorts.map((entry) => entry.layer)).size).toBe(3);
});

for (const entry of throwingPorts) {
  it(`a throwing ${entry.port} becomes ${entry.code} at ${entry.layer}`, async () => {
    const result = await openWith(entry.input);

    // The LAYER is asserted separately from the code: a single refusal shape
    // with a constant layer would make "which layer refused" unanswerable.
    expect(result).toEqual({
      code: entry.code,
      detail: expect.stringContaining("exploded"),
      layer: entry.layer,
      outcome: "UNKNOWN",
    });
  });
}

it("a throwing distribution port refuses closed without reaching the daemon", async () => {
  // The distribution vocabulary has no discovery-port-failed reason, and adding
  // one is barred. Zero components were obtained, so the required set is
  // literally incomplete — the true statement, not a stand-in for one.
  const { calls, ports } = harness({ distributions: { throws: new Error("read exploded") } });
  const session = createJetBrainsSession(ports, { apiCompatibilityRange: API_RANGE });

  expect(await session.openControlRoom()).toEqual({
    code: "DISTRIBUTION_MISMATCH",
    ok: false,
    reason: "COMPONENT_SET_INCOMPLETE",
    refusedBy: "DISTRIBUTION_STARTUP",
  });
  expect(calls.probeDaemon).toBe(0);
});

it("passes a refusing discovery port through with its own layer", async () => {
  expect(await openWith({ discovery: { detail: "socket refused", status: "REFUSED" } })).toEqual({
    code: "DAEMON_DISCOVERY_REFUSED",
    detail: "socket refused",
    layer: "DAEMON_DISCOVERY_PORT",
    outcome: "REFUSED",
  });
});

it("refuses missing control-room assets at the control room port", async () => {
  const result = await openWith({
    controlRoom: { assets: "ABSENT", detail: "no bundle on disk" },
  });

  expect(result).toEqual({
    code: "CONTROL_ROOM_ASSETS_MISSING",
    detail: "no bundle on disk",
    layer: "CONTROL_ROOM_OPEN_PORT",
    outcome: "REFUSED",
  });
});

// ---------------------------------------------------------------------------
// Vocabulary discipline: the adapter produces codes from the frozen tuple and
// never adds to it.
// ---------------------------------------------------------------------------

const producedCodes: ReadonlyArray<{ readonly code: IdeAdapterReasonCode; readonly run: () => Promise<JetBrainsResult> }> = [
  { code: "CONTROL_ROOM_EMBEDDED", run: () => openWith({ controlRoom: EMBEDDED }) },
  { code: "CONTROL_ROOM_BROWSER_FALLBACK", run: () => openWith({ controlRoom: FALLBACK }) },
  {
    code: "CONTROL_ROOM_ASSETS_MISSING",
    run: () => openWith({ controlRoom: { assets: "ABSENT", detail: "gone" } }),
  },
  {
    code: "CONTROL_ROOM_OPEN_UNKNOWN",
    run: () => openWith({ controlRoom: { throws: new Error("exploded") } }),
  },
  {
    code: "DAEMON_DISCOVERY_REFUSED",
    run: () => openWith({ discovery: { detail: "refused", status: "REFUSED" } }),
  },
  {
    code: "DAEMON_STATE_UNKNOWN",
    run: () => openWith({ discovery: { detail: "undetermined", status: "UNDETERMINED" } }),
  },
  {
    code: "DAEMON_START_UNVERIFIED",
    run: () =>
      openWith({ discovery: ABSENT, start: { detail: "unconfirmed", status: "LAUNCHED_UNCONFIRMED" } }),
  },
  {
    code: "DAEMON_START_REFUSED",
    run: () => openWith({ discovery: ABSENT, start: { detail: "refused", status: "REFUSED" } }),
  },
];

it("produces only codes that exist in the frozen contract vocabulary", async () => {
  // Pinned by count as well as membership: a silently dropped case would shrink
  // the sweep to zero and still pass a pure membership assertion.
  expect(producedCodes.length).toBe(8);

  const observed = await Promise.all(
    producedCodes.map(async (entry) => {
      const result = await entry.run();
      // Narrowing IS the assertion: none of these scenarios may answer in the
      // distribution vocabulary, so a verdict re-coded across the two boundaries
      // fails here rather than being silently accepted as a member.
      if ("ok" in result) throw new Error(`expected an IDE verdict, got ${result.reason}`);
      return result.code;
    }),
  );

  expect(observed).toEqual(producedCodes.map((entry) => entry.code));
  expect(observed.every((code) => IDE_ADAPTER_REASON_CODES.includes(code))).toBe(true);
});
