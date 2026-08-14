/**
 * The four real ports, exercised against real resources: a real filesystem, real
 * `node:http` servers, and real child processes. A scripted double could satisfy
 * every assertion here while the production port still failed on contact with
 * the OS, which is the whole reason this task exists.
 *
 * Each case pins the evidence ARM the port produces AND the code, outcome and
 * refusing layer the contract then derives from it. Asserting only "it failed"
 * would stay green after a second layer started answering first.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideControlRoomOpen,
  decideDaemonDiscovery,
  decideDaemonStart,
} from "@moe/ide-adapter-contract";
import type { IdeAdapterResult } from "@moe/ide-adapter-contract";
import type { DistributionManifest } from "@moe/contracts";
import { afterAll, expect, it } from "vitest";

import { createJetBrainsHost } from "./jetbrains-host.js";
import type { JetBrainsHostConfig } from "./jetbrains-host.js";
import {
  openControlRoom,
  probeDaemon,
  readInstalledDistributions,
  startDaemon,
} from "./jetbrains-host-ports.js";

/**
 * Hand-transcribed. Every evidence arm the four ports can produce, one case
 * each, plus every composition the host is responsible for.
 */
const COVERED_ARMS = [
  "compose:refuses-before-daemon-access",
  "compose:single-flight",
  "compose:success",
  "compose:thin-surface",
  "compose:uninstall-mid-flight",
  "compose:uninstall-then-reconnect",
  "control-room:assets-absent",
  "control-room:browser-opened",
  "control-room:browser-refused",
  "control-room:browser-undetermined",
  "discovery:listening-200",
  "discovery:listening-401",
  "discovery:not-listening",
  "discovery:undetermined",
  "distribution:manifests-in-order",
  "distribution:not-json",
  "distribution:root-absent",
  "distribution:unreadable-entry",
  "start:launched-unconfirmed",
  "start:listening-confirmed",
  "start:refused",
] as const;

const recorded = new Set<string>();
const record = (arm: (typeof COVERED_ARMS)[number]): void => void recorded.add(arm);

const PROBE_MS = 400;
const CONFIRM_MS = 600;
const OPEN_MS = 400;
const CASE_TIMEOUT_MS = 30_000;

const temps: string[] = [];
const servers: Server[] = [];

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "moe-jb-host-"));
  temps.push(root);
  return root;
};

/** A real listening server. Its port is what makes NOT_LISTENING provable later. */
const listening = async (handler: (status: number) => number): Promise<number> => {
  const server = createServer((_request, response) => {
    response.writeHead(handler(200));
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was assigned");
  return address.port;
};

/** A port nothing listens on: bound, then released. Yields a real ECONNREFUSED. */
const deadPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was assigned");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of temps) rmSync(root, { force: true, recursive: true });
});

/**
 * Turns a hang into a NAMED failure. An unbounded confirm loop would otherwise
 * stall the suite, and a stalled suite reads as infrastructure trouble rather
 * than as the defect it is.
 */
const bounded = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`bounded wait expired: ${what}`)), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

/** Pins the code, the outcome AND the refusing layer, never just "not OK". */
const verdict = (result: IdeAdapterResult): Record<string, string | null> => ({
  code: result.code,
  layer: "layer" in result ? result.layer : null,
  outcome: result.outcome,
});

const manifest = (componentId: string, componentKind: string): DistributionManifest =>
  ({
    aggregateDigest: "a".repeat(64),
    apiCompatibilityRange: {
      commandEnvelopeVersion: "moe-runtime-command/1",
      errorRegistryVersion: "moe-error-registry/1",
      queryEnvelopeVersion: "moe-runtime-query/1",
    },
    assets: [],
    buildToolVersions: { node: "24.16.0" },
    builtInSkills: [],
    componentId,
    componentKind,
    contractSchemaHash: "b".repeat(64),
    instructionTemplates: [],
    manifestVersion: "moe-distribution-manifest/1",
    signatureAlgorithm: "ed25519",
    signingKeyId: "release-key-1",
    source: { objectFormat: "sha256", sourceSha: "c".repeat(64) },
  }) as DistributionManifest;

const installRoot = (files: ReadonlyArray<readonly [string, string]>): string => {
  const root = tempRoot();
  for (const [name, body] of files) writeFileSync(join(root, name), body, "utf8");
  return root;
};

it("reads well-formed installed manifests in a deterministic order", async () => {
  const root = installRoot([
    ["20-control-room.json", JSON.stringify(manifest("control-room", "CONTROL_ROOM"))],
    ["10-daemon.json", JSON.stringify(manifest("daemon", "DAEMON"))],
  ]);
  const found = await readInstalledDistributions(root);
  expect(found.map((entry) => entry.componentId)).toEqual(["daemon", "control-room"]);
  record("distribution:manifests-in-order");
});

it("yields an EMPTY set when the install root does not exist", async () => {
  // Empty, never partial: admitDistribution refuses an empty set, whereas a
  // partial one silently tolerates the very component that went missing.
  expect(await readInstalledDistributions(join(tempRoot(), "absent"))).toEqual([]);
  record("distribution:root-absent");
});

it("yields an EMPTY set when one entry is unreadable, dropping the readable ones", async () => {
  const root = installRoot([["10-daemon.json", JSON.stringify(manifest("daemon", "DAEMON"))]]);
  mkdirSync(join(root, "20-unreadable.json"));
  expect(await readInstalledDistributions(root)).toEqual([]);
  record("distribution:unreadable-entry");
});

it("yields an EMPTY set when one document is not JSON", async () => {
  const root = installRoot([
    ["10-daemon.json", JSON.stringify(manifest("daemon", "DAEMON"))],
    ["20-broken.json", "{ this is not json"],
  ]);
  expect(await readInstalledDistributions(root)).toEqual([]);
  record("distribution:not-json");
});

it("reports a reachable daemon as LISTENING with its endpoint", async () => {
  const port = await listening(() => 200);
  const endpoint = `http://127.0.0.1:${port}/`;
  const evidence = await probeDaemon(endpoint, PROBE_MS);
  expect(evidence).toEqual({ endpoint, status: "LISTENING" });
  expect(verdict(decideDaemonDiscovery(evidence)))
    .toEqual({ code: "DAEMON_RUNNING", layer: null, outcome: "OK" });
  record("discovery:listening-200");
}, CASE_TIMEOUT_MS);

it("reports an HTTP 401 as LISTENING, because the probe observes reach, not authority", async () => {
  // The probe carries no credential — it runs before any session exists — so an
  // authenticated refusal is positive evidence the daemon is up. Mapping it to a
  // refusal would start a second daemon beside a healthy one.
  const port = await listening(() => 401);
  const endpoint = `http://127.0.0.1:${port}/`;
  const evidence = await probeDaemon(endpoint, PROBE_MS);
  expect(evidence).toEqual({ endpoint, status: "LISTENING" });
  expect(verdict(decideDaemonDiscovery(evidence)))
    .toEqual({ code: "DAEMON_RUNNING", layer: null, outcome: "OK" });
  record("discovery:listening-401");
}, CASE_TIMEOUT_MS);

it("reports a refused connection as NOT_LISTENING, which licenses a start", async () => {
  const evidence = await probeDaemon(`http://127.0.0.1:${await deadPort()}/`, PROBE_MS);
  expect(evidence).toEqual({ status: "NOT_LISTENING" });
  expect(verdict(decideDaemonDiscovery(evidence)))
    .toEqual({ code: "DAEMON_ABSENT", layer: null, outcome: "OK" });
  record("discovery:not-listening");
}, CASE_TIMEOUT_MS);

it("reports a stalled probe as UNDETERMINED with a detail carrying no secret", async () => {
  const server = createServer(() => {
    /* never responds: the probe's own bound is the only thing that ends this */
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was assigned");
  // The secret rides in the PATH, not in URL credentials: `fetch` rejects a URL
  // carrying credentials before it ever connects, which would settle this case
  // on a parse error instead of on the timeout it is here to exercise.
  const secret = "s3cr3t-probe-token";
  const evidence = await bounded(
    probeDaemon(`http://127.0.0.1:${address.port}/session/${secret}`, PROBE_MS),
    CASE_TIMEOUT_MS - 1_000,
    "probeDaemon must honour its own timeout",
  );
  expect(evidence).toMatchObject({ status: "UNDETERMINED" });
  const detail = (evidence as { readonly detail: string }).detail;
  expect(detail.length).toBeGreaterThan(0);
  for (const leak of [secret, "127.0.0.1", String(address.port), "://"]) {
    expect(detail, `the detail must not carry ${leak}`).not.toContain(leak);
  }
  expect(verdict(decideDaemonDiscovery(evidence))).toEqual({
    code: "DAEMON_STATE_UNKNOWN",
    layer: "DAEMON_DISCOVERY_PORT",
    outcome: "UNKNOWN",
  });
  record("discovery:undetermined");
}, CASE_TIMEOUT_MS);

it("confirms a spawned daemon that reaches listening within the bound", async () => {
  const port = await deadPort();
  const endpoint = `http://127.0.0.1:${port}/`;
  const evidence = await bounded(
    startDaemon({
      args: [
        "-e",
        `require("node:http").createServer((q,s)=>{s.writeHead(200);s.end("{}")})` +
          `.listen(${port},"127.0.0.1");setTimeout(()=>process.exit(0),8000)`,
      ],
      command: process.execPath,
      confirmIntervalMs: 50,
      confirmTimeoutMs: 8_000,
      endpoint,
    }),
    CASE_TIMEOUT_MS - 1_000,
    "startDaemon must settle once the child listens",
  );
  expect(evidence).toEqual({ endpoint, status: "LISTENING_CONFIRMED" });
  expect(verdict(decideDaemonStart(evidence)))
    .toEqual({ code: "DAEMON_STARTED", layer: null, outcome: "OK" });
  record("start:listening-confirmed");
}, CASE_TIMEOUT_MS);

it("reports a spawn that never listens as LAUNCHED_UNCONFIRMED, inside its bound", async () => {
  const endpoint = `http://127.0.0.1:${await deadPort()}/`;
  const started = process.hrtime.bigint();
  const evidence = await bounded(
    startDaemon({
      // Spawns cleanly and exits at once. It never listens, so only the bound
      // can end the confirm loop — remove the bound and this case hangs.
      args: ["-e", ""],
      command: process.execPath,
      confirmIntervalMs: 50,
      confirmTimeoutMs: CONFIRM_MS,
      endpoint,
    }),
    CASE_TIMEOUT_MS - 1_000,
    "startDaemon must give up at confirmTimeoutMs",
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  expect(evidence).toMatchObject({ status: "LAUNCHED_UNCONFIRMED" });
  expect(elapsedMs, "the confirm loop must be bounded").toBeLessThan(CONFIRM_MS * 6);
  expect(verdict(decideDaemonStart(evidence))).toEqual({
    code: "DAEMON_START_UNVERIFIED",
    layer: "IDE_ADAPTER",
    outcome: "UNKNOWN",
  });
  record("start:launched-unconfirmed");
}, CASE_TIMEOUT_MS);

it("reports an unlaunchable command as REFUSED at the start port", async () => {
  const evidence = await bounded(
    startDaemon({
      args: [],
      command: join(tempRoot(), "no-such-daemon-binary"),
      confirmIntervalMs: 50,
      confirmTimeoutMs: CONFIRM_MS,
      endpoint: `http://127.0.0.1:${await deadPort()}/`,
    }),
    CASE_TIMEOUT_MS - 1_000,
    "startDaemon must settle when the spawn itself fails",
  );
  expect(evidence).toMatchObject({ status: "REFUSED" });
  expect(verdict(decideDaemonStart(evidence))).toEqual({
    code: "DAEMON_START_REFUSED",
    layer: "DAEMON_START_PORT",
    outcome: "REFUSED",
  });
  record("start:refused");
}, CASE_TIMEOUT_MS);

it("opens present assets in the browser and NEVER claims an embedded view", async () => {
  const root = tempRoot();
  const asset = join(root, "index.html");
  writeFileSync(asset, "<!doctype html>", "utf8");
  const opened: string[] = [];
  const evidence = await openControlRoom(asset, async (target) => void opened.push(target), OPEN_MS);
  // embedded is UNAVAILABLE by construction: this host renders nothing, so an
  // OPENED embedded arm would be a claim it cannot support.
  expect(evidence).toEqual({
    assets: "PRESENT",
    browser: { detail: "the control room was opened in the default browser", status: "OPENED" },
    embedded: "UNAVAILABLE",
  });
  // The opener receives the real path; the DETAIL must not repeat it. Details
  // reach logs and IDE notifications, and an absolute host path is a leak there.
  expect(opened).toEqual([asset]);
  expect((evidence as { readonly browser: { readonly detail: string } }).browser.detail)
    .not.toContain(root);
  expect(verdict(decideControlRoomOpen(evidence)))
    .toEqual({ code: "CONTROL_ROOM_BROWSER_FALLBACK", layer: null, outcome: "OK" });
  record("control-room:browser-opened");
});

it("reports missing assets as ABSENT without ever calling the opener", async () => {
  const opened: string[] = [];
  const evidence = await openControlRoom(
    join(tempRoot(), "absent", "index.html"),
    async (target) => void opened.push(target),
    OPEN_MS,
  );
  expect(evidence).toMatchObject({ assets: "ABSENT" });
  expect(opened, "a missing asset must not reach the OS opener").toEqual([]);
  expect(verdict(decideControlRoomOpen(evidence))).toEqual({
    code: "CONTROL_ROOM_ASSETS_MISSING",
    layer: "CONTROL_ROOM_OPEN_PORT",
    outcome: "REFUSED",
  });
  record("control-room:assets-absent");
});

it("reports an opener that throws as a browser REFUSED, not as an escaped exception", async () => {
  const root = tempRoot();
  const asset = join(root, "index.html");
  writeFileSync(asset, "<!doctype html>", "utf8");
  const evidence = await openControlRoom(asset, async () => {
    throw new Error("no browser is registered for this handler");
  }, OPEN_MS);
  expect(evidence).toMatchObject({
    assets: "PRESENT",
    browser: { status: "REFUSED" },
    embedded: "UNAVAILABLE",
  });
  expect(verdict(decideControlRoomOpen(evidence))).toEqual({
    code: "CONTROL_ROOM_BROWSER_REFUSED",
    layer: "CONTROL_ROOM_OPEN_PORT",
    outcome: "REFUSED",
  });
  record("control-room:browser-refused");
});

it("keeps the host off Node's process-wide handles: no port module opens a socket at import", () => {
  // Importing a port module must not listen, spawn or connect. Proven out of
  // process, because an in-process import would be indistinguishable from the
  // sockets this file's own fixtures already own.
  const source =
    'await import("./src/host/jetbrains-host-ports.ts");' +
    "process.stdout.write(String(process.getActiveResourcesInfo()" +
    '.filter((r) => r === "TCPSERVERWRAP" || r === "TCPWRAP" || r === "ChildProcess").length));';
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8" },
  );
  expect(out.trim()).toBe("0");
}, CASE_TIMEOUT_MS);

/**
 * COMPOSITION. These exercise the host against a real listening daemon, a real
 * install root and a real asset, and they count requests AT THE SERVER rather
 * than through a spy — "the probe never fired" is then a fact about the socket,
 * not about a double that could have been wired wrongly.
 */
const RANGE = {
  commandEnvelopeVersion: "moe-runtime-command/1",
  errorRegistryVersion: "moe-error-registry/1",
  queryEnvelopeVersion: "moe-runtime-query/1",
};

interface Fixture {
  readonly config: JetBrainsHostConfig;
  readonly endpoint: string;
  readonly opened: readonly string[];
  readonly requests: () => number;
}

const fixture = async (
  components: ReadonlyArray<readonly [string, string]>,
): Promise<Fixture> => {
  let received = 0;
  const server = createServer((_request, response) => {
    received += 1;
    response.writeHead(200);
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port was assigned");

  const root = installRoot(
    components.map(([id, kind]) => [`${id}.json`, JSON.stringify(manifest(id, kind))] as const),
  );
  const assets = tempRoot();
  const assetPath = join(assets, "index.html");
  writeFileSync(assetPath, "<!doctype html>", "utf8");
  const opened: string[] = [];
  const endpoint = `http://127.0.0.1:${address.port}/`;

  return {
    config: {
      apiCompatibilityRange: RANGE,
      controlRoomAssetPath: assetPath,
      controlRoomOpenTimeoutMs: OPEN_MS,
      daemonArgs: ["-e", ""],
      daemonCommand: process.execPath,
      endpoint,
      installRoot: root,
      opener: async (target) => void opened.push(target),
      probeTimeoutMs: PROBE_MS,
      startConfirmIntervalMs: 50,
      startConfirmTimeoutMs: CONFIRM_MS,
    },
    endpoint,
    opened,
    requests: () => received,
  };
};

const COMPLETE = [["daemon", "DAEMON"], ["control-room", "CONTROL_ROOM"]] as const;

it("reaches the control room over a live daemon and reports its endpoint", async () => {
  const scene = await fixture(COMPLETE);
  const host = createJetBrainsHost(scene.config);
  const result = await bounded(host.start(), CASE_TIMEOUT_MS - 1_000, "host.start must settle");
  expect(verdict(result as IdeAdapterResult))
    .toEqual({ code: "CONTROL_ROOM_BROWSER_FALLBACK", layer: null, outcome: "OK" });
  expect(host.endpoint()).toBe(scene.endpoint);
  expect(scene.opened.length).toBe(1);
  record("compose:success");
}, CASE_TIMEOUT_MS);

it("keeps the adapter's single flight across composition: one probe, one open", async () => {
  // A double-clicked tool window fires this twice. Two runs would both observe
  // the daemon and both open the control room; two ABSENT observations would
  // start two daemons, which is exactly what the reconnect guarantee prevents.
  const scene = await fixture(COMPLETE);
  const host = createJetBrainsHost(scene.config);
  const first = host.start();
  const second = host.start();
  expect(second).toBe(first);
  await bounded(Promise.all([first, second]), CASE_TIMEOUT_MS - 1_000, "both flights must settle");
  expect(scene.requests(), "the daemon must be probed exactly once").toBe(1);
  expect(scene.opened.length).toBe(1);
  record("compose:single-flight");
}, CASE_TIMEOUT_MS);

it("drops every live handle when uninstall lands mid-flight", async () => {
  const scene = await fixture(COMPLETE);
  const host = createJetBrainsHost(scene.config);
  const flight = host.start();
  host.uninstall();
  const result = await bounded(flight, CASE_TIMEOUT_MS - 1_000, "the torn flight must settle");
  expect(verdict(result as IdeAdapterResult)).toEqual({
    code: "DAEMON_STATE_UNKNOWN",
    layer: "IDE_ADAPTER",
    outcome: "UNKNOWN",
  });
  // Proven by absence at the socket and at the opener, not by a status field.
  expect(scene.requests(), "no port may fire after teardown").toBe(0);
  expect(scene.opened).toEqual([]);
  expect(host.endpoint()).toBeNull();
  record("compose:uninstall-mid-flight");
}, CASE_TIMEOUT_MS);

it("reconnects on a fresh session after an uninstall", async () => {
  const scene = await fixture(COMPLETE);
  const host = createJetBrainsHost(scene.config);
  host.uninstall();
  const result = await bounded(
    host.reconnect(),
    CASE_TIMEOUT_MS - 1_000,
    "the reconnect must settle",
  );
  expect(verdict(result as IdeAdapterResult))
    .toEqual({ code: "CONTROL_ROOM_BROWSER_FALLBACK", layer: null, outcome: "OK" });
  expect(host.endpoint()).toBe(scene.endpoint);
  record("compose:uninstall-then-reconnect");
}, CASE_TIMEOUT_MS);

it("refuses an incomplete distribution BEFORE the daemon is ever touched", async () => {
  // "Before daemon access" is the load-bearing half of the requirement: a
  // refusal that had already probed would prove only that it refused eventually.
  const scene = await fixture([["control-room", "CONTROL_ROOM"]]);
  const host = createJetBrainsHost(scene.config);
  const result = await bounded(host.start(), CASE_TIMEOUT_MS - 1_000, "the refusal must settle");
  expect(result).toEqual({
    code: "DISTRIBUTION_MISMATCH",
    ok: false,
    reason: "COMPONENT_SET_INCOMPLETE",
    refusedBy: "DISTRIBUTION_STARTUP",
  });
  expect(scene.requests(), "the daemon must not be probed by a refused startup").toBe(0);
  expect(scene.opened).toEqual([]);
  record("compose:refuses-before-daemon-access");
}, CASE_TIMEOUT_MS);

it("exposes a thin surface: four launcher methods and no product authority", async () => {
  // Pinned as an exact set. A reducer, a command entry point or a render hook
  // added later is then a visible decision rather than a quiet widening.
  const scene = await fixture(COMPLETE);
  const host = createJetBrainsHost(scene.config);
  expect(Object.keys(host).sort()).toEqual(["endpoint", "reconnect", "start", "uninstall"]);
  record("compose:thin-surface");
});

it("reports an opener that never answers as UNDETERMINED, inside its own bound", async () => {
  // An OS open call that never returns would otherwise freeze the IDE thread
  // that called it. UNDETERMINED rather than REFUSED: the browser may still be
  // opening, and claiming a refusal invites a caller to retry on top of it.
  const asset = join(tempRoot(), "index.html");
  writeFileSync(asset, "<!doctype html>", "utf8");
  const started = process.hrtime.bigint();
  const evidence = await bounded(
    openControlRoom(asset, () => new Promise<void>(() => {}), OPEN_MS),
    CASE_TIMEOUT_MS - 1_000,
    "openControlRoom must give up on an opener that never answers",
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  expect(elapsedMs, "the opener wait must be bounded").toBeLessThan(OPEN_MS * 6);
  expect(evidence).toMatchObject({
    assets: "PRESENT",
    browser: { status: "UNDETERMINED" },
    embedded: "UNAVAILABLE",
  });
  expect(verdict(decideControlRoomOpen(evidence))).toEqual({
    code: "CONTROL_ROOM_OPEN_UNKNOWN",
    layer: "IDE_ADAPTER",
    outcome: "UNKNOWN",
  });
  record("control-room:browser-undetermined");
}, CASE_TIMEOUT_MS);

it("ran every arm it claims to cover, and only those", () => {
  // A sweep that silently produces zero cases passes while testing nothing. This
  // compares what actually EXECUTED against the hand-written list above, so a
  // case that stops running is a failure rather than a quiet reduction in scope.
  expect(COVERED_ARMS.length).toBe(21);
  expect([...recorded].sort()).toEqual([...COVERED_ARMS]);
});
