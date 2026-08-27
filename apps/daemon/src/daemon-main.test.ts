import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, expect, it } from "vitest";

import { runDaemonMain } from "./daemon-main.js";
import { FOUNDATION_RECEIPT_SCHEMA_VERSION } from "./host/foundation-receipts.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import type { CancellablePairingOperatorInput } from "./http/pairing-operator-channel.js";

/**
 * Two things this entry owns, proved here against the PRODUCTION dependency
 * provider over a real file-backed store:
 *
 * 1. The bin's `--csrf-token` flag reaches the listener gate.
 * 2. The host receipts J3 reads. Readiness is published AFTER the boot
 *    reconciliation sweep — the ordering `startDaemon` documents is inherited,
 *    not rebuilt — and the graceful drain publishes exactly one shutdown
 *    receipt, with a second drain refused by the entry's own code and layer.
 *    Both receipts are byte-deterministic: the instant is injected, so two runs
 *    of the same process over the same store encode identically.
 */

const KNOWN_TOKEN = "dev-csrf-token-1";
const PROJECT = "proj-daemon-receipts";
const INSTANT = "2026-08-18T20:15:30.500Z";
const OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel";
const PAIRING_BODY_KEYS = Object.freeze(["confirmationLabel", "ok", "requestId"] as const);
const PAIRING_PROMPT =
  "A browser wants to pair. Type the code shown in that browser here, then press Enter.";
const NO_OPERATOR_PROMPT =
  "A browser wants to pair, but this daemon has no operator terminal. Stop it and run pnpm start from a terminal window.";

const PROVIDER_SOURCE = `export default {
  provide() {
    return {
      authenticator: { authenticate() { return { verdict: "UNAUTHENTICATED" }; } },
      decisions: { decide() { throw new Error("unreachable"); } },
      registry: new Map(),
    };
  },
};
`;

/**
 * The SHIPPED provider, wrapped only to WITNESS the sweep. The reconciliation
 * port, the store and the project are the production ones; the wrapper decides
 * nothing and answers nothing — it pushes a marker and delegates.
 */
function witnessSource(providerUrl: string): string {
  return `import provider from ${JSON.stringify(providerUrl)};
const marks = (globalThis.__moeBootMarks ??= []);
export default {
  ...provider,
  reconciliation() {
    const port = provider.reconciliation();
    return { sweep: () => { marks.push("SWEPT"); return port.sweep(); } };
  },
};
`;
}

interface Receipt {
  readonly entry?: string;
  readonly instant?: string;
  readonly kind?: string;
  readonly pid?: number;
  readonly projectId?: string;
  readonly schemaVersion?: string;
  readonly storePath?: string;
  readonly trigger?: string;
}

function receipts(lines: readonly string[]): readonly Receipt[] {
  return lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const parsed = JSON.parse(line) as Receipt;
    return parsed.schemaVersion === FOUNDATION_RECEIPT_SCHEMA_VERSION ? [parsed] : [];
  });
}

function marks(): string[] {
  return ((globalThis as { __moeBootMarks?: string[] }).__moeBootMarks ??= []);
}

const cleanups: (() => Promise<unknown>)[] = [];

const STORE_ENV_KEYS = ["MOE_DAEMON_CREDENTIAL", "MOE_PROJECT_ID", "MOE_STORE_PATH"] as const;
const ENV_BEFORE = Object.freeze(
  Object.fromEntries(STORE_ENV_KEYS.map((key) => [key, process.env[key]])),
);

afterAll(async () => {
  // Restored, not left behind: this file writes the real environment so the
  // shipped provider opens a scratch store, and a leaked path would follow the
  // worker into whatever file it runs next.
  for (const key of STORE_ENV_KEYS) {
    const before = ENV_BEFORE[key];
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  for (const cleanup of cleanups.reverse()) {
    // The production provider caches an open SQLite handle for the process; a
    // failed temp cleanup must not take the worker down with it.
    try { await cleanup(); } catch { /* handle still held; the OS temp dir survives */ }
  }
});

async function scratch(name: string): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), `moe-daemon-${name}-`));
  cleanups.push(() => rm(temp, { force: true, recursive: true }));
  return temp;
}

/** The shipped provider path, wrapped by the witness module written beside it. */
async function witnessProvider(temp: string): Promise<string> {
  const providerUrl = pathToFileURL(
    join(import.meta.dirname, "daemon-store-dependencies.ts"),
  ).href;
  const witnessPath = join(temp, "witness-provider.mjs");
  await writeFile(witnessPath, witnessSource(providerUrl), "utf8");
  return witnessPath;
}

/**
 * ONE store for every production-composed case in this file. The shipped
 * provider caches the store it opened from the environment for the life of the
 * process, so a second directory here would hand the receipt a path the daemon
 * is not actually serving — the very lie these tests exist to catch.
 */
let sharedStorePath: string | null = null;

async function productionHost(): Promise<{ storePath: string; witnessPath: string }> {
  if (sharedStorePath === null) sharedStorePath = join(await scratch("receipts"), "store.sqlite");
  const storePath = sharedStorePath;
  const env = storeEnv(storePath);
  // The provider reads the REAL environment; the receipt reads the same values
  // through `options.env`, so both name one store.
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return { storePath, witnessPath: await witnessProvider(await scratch("witness")) };
}

function storeEnv(storePath: string): Record<string, string> {
  return {
    MOE_DAEMON_CREDENTIAL: "daemon-receipt-credential",
    MOE_PROJECT_ID: PROJECT,
    MOE_STORE_PATH: storePath,
  };
}

interface PairingMainHarness {
  readonly lines: string[];
  readonly origin: string;
}

function finiteOperatorInput(): CancellablePairingOperatorInput {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<string> { return; },
    destroy: () => undefined,
  };
}

async function withPairingMain(
  operatorChannelAvailable: boolean,
  run: (harness: PairingMainHarness) => Promise<void>,
): Promise<void> {
  const { storePath, witnessPath } = await productionHost();
  const lines: string[] = [];
  let origin = "";
  let shutdown: ((trigger?: string) => Promise<unknown>) | undefined;
  const code = await runDaemonMain(
    [`--dependencies=${witnessPath}`, "--port=0", `--csrf-token=${KNOWN_TOKEN}`],
    {
      env: storeEnv(storePath),
      log: (line) => {
        lines.push(line);
        origin = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(line)?.[1] ?? origin;
      },
      ...(operatorChannelAvailable ? { operatorInput: finiteOperatorInput() } : {}),
      onStarted: (stop) => { shutdown = stop; },
    },
  );
  if (code !== 0 || origin === "" || shutdown === undefined) {
    await shutdown?.("PAIRING_TEST_START_FAILED");
    throw new Error("production pairing host did not start");
  }
  try { await run({ lines, origin }); }
  finally { await shutdown("PAIRING_TEST_STOP"); }
}

async function requestPairing(origin: string, body: unknown): Promise<{
  readonly body: Record<string, unknown>;
  readonly operatorChannel: string | null;
  readonly status: number;
}> {
  const response = await fetch(`${origin}/session/pair/request`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "x-moe-csrf": KNOWN_TOKEN,
      "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    },
    method: "POST",
  });
  return {
    body: await response.json() as Record<string, unknown>,
    operatorChannel: response.headers.get(OPERATOR_CHANNEL_HEADER),
    status: response.status,
  };
}

function expectPairingIdentityIsSecret(
  body: Readonly<Record<string, unknown>>,
  lines: readonly string[],
): void {
  expect(Object.keys(body).toSorted()).toEqual([...PAIRING_BODY_KEYS].toSorted());
  expect(PAIRING_BODY_KEYS).toHaveLength(3);
  expect([...PAIRING_BODY_KEYS].toSorted()).toEqual(Object.keys(body).toSorted());
  expect(body["ok"]).toBe(true);
  const identity = [body["confirmationLabel"], body["requestId"]];
  expect(identity.every((value) => typeof value === "string" && value.length > 0)).toBe(true);
  expect(lines.some((line) => identity.some((value) => line.includes(String(value))))).toBe(false);
}

it("passes --csrf-token through to the listener gate", async () => {
  const temp = await scratch("csrf");
  const providerPath = join(temp, "provider.mjs");
  await writeFile(providerPath, PROVIDER_SOURCE, "utf8");

  let origin = "";
  let shutdown: ((trigger?: string) => Promise<unknown>) | undefined;
  const code = await runDaemonMain(
    [`--dependencies=${providerPath}`, "--port=0", `--csrf-token=${KNOWN_TOKEN}`],
    {
      log: (line) => {
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(line);
        if (match?.[1] !== undefined) origin = match[1];
      },
      onStarted: (stop) => { shutdown = stop; },
    },
  );
  cleanups.push(async () => shutdown?.());
  expect(code).toBe(0);
  expect(origin).not.toBe("");

  const headers = { "content-type": "application/json", origin, "x-moe-csrf": KNOWN_TOKEN };
  const withToken = await fetch(`${origin}/command`, {
    body: "{}", headers, method: "POST",
  });
  // 401 AUTHENTICATION_FAILED, not 403 LISTENER_CSRF_INVALID: the CSRF gate passed
  // on the flag-supplied token and the next layer answered.
  expect(withToken.status).toBe(401);
  const body = (await withToken.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("AUTHENTICATION_FAILED");

  const withoutToken = await fetch(`${origin}/command`, {
    body: "{}", headers: { "content-type": "application/json", origin }, method: "POST",
  });
  expect(withoutToken.status).toBe(403);
  expect(await withoutToken.json()).toMatchObject({ code: "LISTENER_CSRF_INVALID" });
});

/**
 * The bin's `--asset-root` reaches the static host WITH the credential the
 * shipped provider authenticates by (`MOE_DAEMON_CREDENTIAL`), so a bundle that
 * has that credential baked in refuses the start by name - the path printed,
 * the value not - and a clean bundle is hosted on the daemon's own origin with
 * the policy headers on.
 */
it("hands the daemon credential to the static host's secret scan and hosts a clean bundle", async () => {
  const temp = await scratch("asset-root");
  const providerPath = join(temp, "provider.mjs");
  await writeFile(providerPath, PROVIDER_SOURCE, "utf8");
  const credential = "baked-daemon-credential-0123456789abcdef";

  const leaking = join(temp, "leaking");
  await mkdir(join(leaking, "assets"), { recursive: true });
  await writeFile(join(leaking, "index.html"), "<!doctype html><title>moe</title>\n", "utf8");
  await writeFile(
    join(leaking, "assets", "index-abc.js"), `export const c = "${credential}";\n`, "utf8",
  );
  const refusedLines: string[] = [];
  const refused = await runDaemonMain(
    [`--dependencies=${providerPath}`, "--port=0", `--asset-root=${leaking}`],
    { env: { MOE_DAEMON_CREDENTIAL: credential }, log: (line) => refusedLines.push(line) },
  );
  expect(refused).toBe(1);
  const refusal = refusedLines.find((line) => line.startsWith("LISTENER_ASSET_ROOT_LEAKS_SECRET"));
  expect(refusal).toContain("LISTENER_ASSET_ROOT_LEAKS_SECRET CONTROL_ROOM_LISTENER");
  expect(refusal).toContain("/assets/index-abc.js");
  expect(refusedLines.join("\n")).not.toContain(credential);

  const clean = join(temp, "clean");
  await mkdir(clean, { recursive: true });
  await writeFile(join(clean, "index.html"), "<!doctype html><title>moe</title>\n", "utf8");
  const cleanLines: string[] = [];
  let origin = "";
  let shutdown: ((trigger?: string) => Promise<unknown>) | undefined;
  const code = await runDaemonMain(
    [`--dependencies=${providerPath}`, "--port=0", `--asset-root=${clean}`],
    {
      env: { MOE_DAEMON_CREDENTIAL: credential },
      log: (line) => {
        cleanLines.push(line);
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(line);
        if (match?.[1] !== undefined) origin = match[1];
      },
      onStarted: (stop) => { shutdown = stop; },
    },
  );
  cleanups.push(async () => shutdown?.());
  expect(code).toBe(0);
  const page = await fetch(`${origin}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(await page.text()).toContain("<title>moe</title>");
  expect(cleanLines.join("\n")).not.toMatch(/pairing token|#pair=|requestId|confirmationLabel/u);
});

it("publishes readiness after the sweep and one shutdown receipt on the drain", async () => {
  const { storePath, witnessPath } = await productionHost();
  const lines: string[] = [];
  marks().length = 0;

  let drain: ((trigger?: string) => Promise<{ code?: string; layer?: string; ok: boolean }>)
    | undefined;
  const code = await runDaemonMain([`--dependencies=${witnessPath}`, "--port=0"], {
    env: storeEnv(storePath),
    instant: () => INSTANT,
    log: (line) => {
      lines.push(line);
      if (receipts([line]).length === 1) marks().push("READY_RECEIPT");
    },
    onStarted: (stop) => { drain = stop; },
  });
  expect(code).toBe(0);
  if (drain === undefined) throw new Error("the entry never reported a started daemon");
  cleanups.push(async () => drain?.());

  const ready = receipts(lines);
  expect(ready.length).toBe(1);
  expect(ready[0]).toEqual({
    entry: "CONTROL_ROOM_HTTP",
    instant: INSTANT,
    kind: "READY",
    pid: process.pid,
    projectId: PROJECT,
    schemaVersion: FOUNDATION_RECEIPT_SCHEMA_VERSION,
    storePath,
  });
  // Reconciliation BEFORE readiness, inherited from startDaemon rather than
  // rebuilt here: a daemon that publishes READY while the last crash is still
  // unclassified is the exact failure the sweep exists to stop.
  expect(marks()).toEqual(["SWEPT", "READY_RECEIPT"]);

  const stopped = await drain("SIGTERM");
  expect(stopped.ok).toBe(true);
  const afterDrain = receipts(lines);
  expect(afterDrain.length).toBe(2);
  expect(afterDrain[1]).toMatchObject({
    entry: "CONTROL_ROOM_HTTP", kind: "SHUTDOWN", projectId: PROJECT, storePath,
    trigger: "SIGTERM",
  });

  // A second drain is refused BY THE ENTRY — its code, its layer — and publishes
  // no second receipt: one durable lifecycle, one authority holder.
  const again = await drain("SIGTERM");
  expect(again).toMatchObject({
    code: "DAEMON_ENTRY_ALREADY_STOPPED", layer: "DAEMON_ENTRY", ok: false,
  });
  expect(lines).toContain("DAEMON_ENTRY_ALREADY_STOPPED DAEMON_ENTRY");
  expect(receipts(lines).length).toBe(2);
}, 30_000);

it("actively closes and awaits the private operator input during daemon drain", async () => {
  const { storePath, witnessPath } = await productionHost();
  let settleNext: ((value: IteratorResult<string>) => void) | undefined;
  let destroys = 0;
  const operatorInput: CancellablePairingOperatorInput = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> =>
        await new Promise<IteratorResult<string>>((resolve) => { settleNext = resolve; }),
    }),
    destroy: (): void => {
      destroys += 1;
      settleNext?.({ done: true, value: undefined });
    },
  };
  let drain: ((trigger?: string) => Promise<{ readonly ok: boolean }>) | undefined;
  const code = await runDaemonMain([`--dependencies=${witnessPath}`, "--port=0"], {
    env: storeEnv(storePath),
    log: () => undefined,
    operatorInput,
    onStarted: (stop) => { drain = stop; },
  });
  expect(code).toBe(0);
  if (drain === undefined) throw new Error("the entry never reported a started daemon");

  expect((await drain("PROGRAMMATIC_STOP")).ok).toBe(true);
  expect(destroys).toBe(1);
}, 30_000);

it("encodes the readiness receipt identically across two runs of the same host", async () => {
  const { storePath, witnessPath } = await productionHost();

  const run = async (): Promise<string> => {
    const lines: string[] = [];
    let drain: ((trigger?: string) => Promise<unknown>) | undefined;
    const code = await runDaemonMain([`--dependencies=${witnessPath}`, "--port=0"], {
      env: storeEnv(storePath),
      instant: () => INSTANT,
      log: (line) => lines.push(line),
      onStarted: (stop) => { drain = stop; },
    });
    expect(code).toBe(0);
    await drain?.("SIGTERM");
    const ready = lines.filter((line) => line.startsWith("{") && line.includes("\"READY\""));
    expect(ready.length).toBe(1);
    return ready[0] as string;
  };

  const encoder = new TextEncoder();
  const first = await run();
  const second = await run();
  expect([...encoder.encode(second)]).toEqual([...encoder.encode(first)]);
}, 30_000);

it("refuses the readiness receipt by name when store identity is absent", async () => {
  const temp = await scratch("no-store");
  const providerPath = join(temp, "provider.mjs");
  await writeFile(providerPath, PROVIDER_SOURCE, "utf8");

  const lines: string[] = [];
  let drain: ((trigger?: string) => Promise<unknown>) | undefined;
  const code = await runDaemonMain([`--dependencies=${providerPath}`, "--port=0"], {
    env: { MOE_PROJECT_ID: PROJECT },
    instant: () => INSTANT,
    log: (line) => lines.push(line),
    onStarted: (stop) => { drain = stop; },
  });
  cleanups.push(async () => drain?.());

  // The daemon IS serving — a receipt it cannot honestly stamp must not fabricate
  // a store identity, and must not take the listener down either. It discloses.
  expect(code).toBe(0);
  expect(lines).toContain("FOUNDATION_RECEIPT_STORE_IDENTITY_ABSENT FOUNDATION_RECEIPTS");
  expect(receipts(lines)).toEqual([]);

  // The drain half refuses for the same reason, naming the same layer, and the
  // underlying listener still stops.
  const stopped = await drain?.("SIGTERM");
  expect(stopped).toMatchObject({ ok: true });
  expect(receipts(lines)).toEqual([]);
  expect(lines.filter((line) => line.startsWith("FOUNDATION_RECEIPT_")).length).toBe(2);
});

it("publishes the real operator-channel fact on a successful pairing request", async () => {
  await withPairingMain(true, async ({ lines, origin }) => {
    const response = await requestPairing(origin, {});

    expect(response.status).toBe(200);
    expect.soft(response.operatorChannel).toBe("true");
    expectPairingIdentityIsSecret(response.body, lines);
    expect.soft(lines.filter((line) => line === PAIRING_PROMPT)).toEqual([PAIRING_PROMPT]);
    expect(lines).not.toContain(NO_OPERATOR_PROMPT);
  });
}, 30_000);

it("publishes false and a factual diagnostic without an operator channel", async () => {
  await withPairingMain(false, async ({ lines, origin }) => {
    const response = await requestPairing(origin, {});

    expect(response.status).toBe(200);
    expect.soft(response.operatorChannel).toBe("false");
    expectPairingIdentityIsSecret(response.body, lines);
    expect.soft(lines.filter((line) => line === NO_OPERATOR_PROMPT)).toEqual([NO_OPERATOR_PROMPT]);
    expect(lines).not.toContain(PAIRING_PROMPT);
  });
}, 30_000);

it("emits no operator-channel claim when the pairing body fence refuses", async () => {
  await withPairingMain(true, async ({ lines, origin }) => {
    const response = await requestPairing(origin, { extra: true });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: "PAIRING_CREATE_REQUEST_INVALID",
      layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });
    expect(response.operatorChannel).toBeNull();
    expect(lines.filter((line) => line === PAIRING_PROMPT || line === NO_OPERATOR_PROMPT)).toEqual([]);
  });
}, 30_000);
