import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLITE_APPLICATION_ID } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ActivationReceiptFs, ActivationReceiptPorts,
} from "../bootstrap/activation-receipts-ports.js";
import type { ActivationReceiptInput } from "../bootstrap/activation-receipts-measure.js";
import type { GitRunResult } from "../repository/git-landing-port.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import {
  ACTIVATION_READ_BACKUP_DEFERRED, ACTIVATION_READ_CODES, ACTIVATION_READ_PATH,
  createActivationReadPort,
} from "./activation-read.js";
import type { ActivationReadPort, ActivationView } from "./activation-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";

/**
 * task-0a5d7212: the activation receipts READ. Every arm drives the COMPOSED LISTENER over
 * a real socket, never `handleActivationReadRequest` directly: a handler-level arm cannot
 * tell "registered" from "written but never routed", and being routable is the point.
 *
 * NO ARM PATCHES THE MEASUREMENT. The production `measureActivationReceipts` runs in every
 * arm; only its PORTS are faked, exactly as `activation-receipts-measure.test.ts` does. An
 * arm that stubbed the measurement would grade the stub.
 */

const PROJECT_ID = "project-activation-read";
const FOREIGN_PROJECT = "project-foreign";
const CSRF = "csrf-activation-read";
const CREDENTIAL = "activation-read-admin";
const NO_CAPABILITY_CREDENTIAL = "activation-read-readonly";
const FOREIGN_PROJECT_CREDENTIAL = "activation-read-foreign";

/** The route's own private layer, asserted as a STRING so exporting it is not required. */
const READ_LAYER = "ACTIVATION_READ";
/** Child A's layer. A per-member refusal must keep THIS one, not be rewritten as the route's. */
const RECEIPTS_LAYER = "DAEMON_ACTIVATION_RECEIPTS";

const PROJECT_ROOT = join(tmpdir(), "moe-activation-read-project");
const ARTIFACT_ROOT = join(tmpdir(), "moe-activation-read-artifact");
const STORE_PATH = join(PROJECT_ROOT, "moe.sqlite");
const HEAD_SHA = "1111111111111111111111111111111111111111";
const ARTIFACT_SHA = "2222222222222222222222222222222222222222";
const SLICE_A = "b".repeat(64);
const SLICE_B = "c".repeat(64);
const CLOCK = "2026-09-04T09:15:00.123Z";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/u;

/**
 * The value that must never reach an operator's screen. `providerCredentials` returns
 * entries whose `.value` holds the REAL token, so a reason string built by interpolating
 * that entry would publish it. This response is rendered verbatim onto a card and into
 * e2e screenshots.
 */
const CANARY_TOKEN = "sk-ant-CANARY-3f9d2b7a1e4c6805-do-not-leak";

const listeners: ControlRoomListener[] = [];
const scratchRoots: string[] = [];

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()?.close();
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, recursive: true });
  }
});

interface FakeState {
  readonly backupCalls: string[];
  readonly existing: Set<string>;
  readonly mkdirCalls: string[];
}

function fakeFs(state: FakeState): ActivationReceiptFs {
  return {
    exists: (path: string) => state.existing.has(path),
    mkdir: (path: string) => {
      state.mkdirCalls.push(path);
    },
    readBytes: () => null,
    list: () => [],
    remove: () => undefined,
    stat: (path: string) => (state.existing.has(path) ? { size: 4096 } : null),
  };
}

const gitOk = (stdout: string): GitRunResult => ({ code: 0, stderr: "", stdout: `${stdout}\n` });
const gitFail = (code: number, stderr: string): GitRunResult => ({ code, stderr, stdout: "" });

/**
 * A healthy project. `backup` THROWS on purpose: the route must never reach it, so an arm
 * that did would fail loudly rather than pass for the wrong reason.
 */
function healthyPorts(): {
  readonly ports: Partial<ActivationReceiptPorts>; readonly state: FakeState;
} {
  const state: FakeState = {
    backupCalls: [], existing: new Set([STORE_PATH]), mkdirCalls: [],
  };
  const ports: Partial<ActivationReceiptPorts> = {
    backup: (_storePath: string, destination: string) => {
      state.backupCalls.push(destination);
      throw new Error("the activation READ reached the real backup port");
    },
    committedProbeRef: () => Promise.resolve("probe/abc"),
    env: { ANTHROPIC_AUTH_TOKEN: CANARY_TOKEN },
    fs: fakeFs(state),
    git: (cwd: string, args: readonly string[]) => {
      if (cwd === PROJECT_ROOT && args[1] === "--show-toplevel") {
        return Promise.resolve(gitOk(PROJECT_ROOT));
      }
      if (cwd === PROJECT_ROOT && args[1] === "HEAD") return Promise.resolve(gitOk(HEAD_SHA));
      if (cwd === ARTIFACT_ROOT && args[1] === "HEAD") return Promise.resolve(gitOk(ARTIFACT_SHA));
      return Promise.resolve(gitFail(128, `fatal: unexpected ${cwd} ${args.join(" ")}`));
    },
    installedPolicySliceRefs: () => Promise.resolve([SLICE_A, SLICE_B]),
    now: () => new Date(CLOCK),
    // This HTTP fixture controls every measurement port; never inherit a host CLI.
    providerVersion: () => Promise.resolve({ code: 0, stderr: "", stdout: "fixture-provider 1.0.0\n" }),
    sqliteApplicationId: () => SQLITE_APPLICATION_ID,
  };
  return { ports, state };
}

const INPUT: ActivationReceiptInput = {
  agentCommand: "claude", artifactRoot: ARTIFACT_ROOT, projectId: PROJECT_ID,
  projectRoot: PROJECT_ROOT, storePath: STORE_PATH,
};

function portFor(overrides: Partial<ActivationReceiptPorts> = {}): ActivationReadPort {
  return createActivationReadPort({
    input: INPUT, ports: { ...healthyPorts().ports, ...overrides },
  });
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential === CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.ADMIN], principalId: "operator", projectId: PROJECT_ID,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === NO_CAPABILITY_CREDENTIAL) {
    return {
      principal: { capabilities: [], principalId: "reader", projectId: PROJECT_ID },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === FOREIGN_PROJECT_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.ADMIN], principalId: "foreign", projectId: FOREIGN_PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

/** A listener whose ONLY wired collaborator is the route under test. */
async function start(port?: ActivationReadPort): Promise<ControlRoomListener> {
  const deps = {
    authenticator: { authenticate: authentication },
    decisions: {
      decide: (): never => { throw new Error("the activation read entered the decision port"); },
    },
    registry: {
      get: (): never => { throw new Error("the activation read entered the registry"); },
    },
  } as unknown as CommandAdapterDeps;
  const started = await startControlRoomListener({
    csrfToken: CSRF, deps, ...(port === undefined ? {} : { activation: port }),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  listeners.push(started);
  return started;
}

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
  readonly text: string;
}

async function readReply(
  listener: ControlRoomListener, method: string, headers: Record<string, string>, payload: string,
): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const outbound = httpRequest(
      listener.origin + ACTIVATION_READ_PATH, { headers, method }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            body: (text === "" ? {} : JSON.parse(text)) as Readonly<Record<string, unknown>>,
            status: response.statusCode ?? 0,
            text,
          });
        });
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

async function post(
  listener: ControlRoomListener,
  options: {
    readonly body?: unknown; readonly credential?: string | null;
    readonly csrf?: string | null; readonly method?: string;
  } = {},
): Promise<Reply> {
  const payload = JSON.stringify(options.body ?? {});
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.csrf !== null) headers["x-moe-csrf"] = options.csrf ?? CSRF;
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await readReply(listener, options.method ?? "POST", headers, payload);
}

function viewOf(reply: Reply): ActivationView {
  if (reply.body["outcome"] !== "ACTIVATION") {
    throw new Error(`not a view: ${JSON.stringify(reply.body)}`);
  }
  return reply.body as unknown as ActivationView;
}

function rowOf(view: ActivationView, member: string): ActivationView["members"][number] {
  const found = view.members.find((row) => row.member === member);
  if (found === undefined) throw new Error(`no row for ${member}`);
  return found;
}

describe("the activation receipts read states every receipt over HTTP without writing", () => {
  it("uses the fixture version probe without requiring an installed provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-activation-read-no-provider-"));
    scratchRoots.push(root);
    const command = join(root, "not-installed-provider");
    const listener = await start(createActivationReadPort({
      input: { ...INPUT, agentCommand: command }, ports: healthyPorts().ports,
    }));
    const view = viewOf(await post(listener));
    expect(rowOf(view, "provider").measured).toBe(true);
    expect(view.provider).toEqual({ command, version: "1.0.0" });
  });

  it("refuses an uninstalled provider when the real version probe is selected", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-activation-read-missing-provider-"));
    scratchRoots.push(root);
    const ports = { ...healthyPorts().ports };
    delete ports.providerVersion;
    const listener = await start(createActivationReadPort({
      input: { ...INPUT, agentCommand: join(root, "not-installed-provider") }, ports,
    }));
    const view = viewOf(await post(listener));
    expect(rowOf(view, "provider")).toMatchObject({
      code: "ACTIVATION_PROVIDER_UNMEASURED", layer: RECEIPTS_LAYER, measured: false, ref: null,
    });
    expect(view.provider).toBeNull();
    expect([...view.blocking]).toEqual(["provider"]);
  });

  it("is REGISTERED, not merely written — the listener does not answer ROUTE_UNKNOWN", async () => {
    const listener = await start(portFor());

    const reply = await post(listener);

    // MEASURED, not assumed: an unregistered path falls through the JSON_ROUTES membership
    // test to the ASSET host, so `status !== 404` would pass while the route did not exist.
    expect(reply.body["code"]).not.toBe("LISTENER_ROUTE_UNKNOWN");
    expect(reply.status).toBe(200);
    expect(reply.body["outcome"]).toBe("ACTIVATION");
  });

  it("answers the five readable members measured, each with the daemon's own reason", async () => {
    const listener = await start(portFor());

    const view = viewOf(await post(listener));

    expect(view.members.map((row) => row.member)).toStrictEqual([
      "repository", "provider", "store", "backup", "distribution", "policy",
    ]);
    for (const member of ["repository", "provider", "store", "distribution", "policy"]) {
      const row = rowOf(view, member);
      expect({ code: row.code, layer: row.layer, measured: row.measured })
        .toStrictEqual({ code: null, layer: null, measured: true });
      expect(row.ref).not.toBe("");
      expect(row.reason).not.toBe("");
    }
    // The two members core validates as a DIGEST rather than as a ref.
    expect(rowOf(view, "distribution").hash).toMatch(LOWER_HEX_64);
    expect(rowOf(view, "policy").hash).toMatch(LOWER_HEX_64);
    expect(view.repository).toStrictEqual({ headSha: HEAD_SHA, toplevel: PROJECT_ROOT });
    expect(view.store).toStrictEqual({ storePath: STORE_PATH });
    expect(view.measuredAt).toBe(CLOCK);
    expect(view.schemaVersion).toBe("moe-activation-receipts/1");
  });

  it("reports the backup as DEFERRED under the ROUTE's layer, never as a failure", async () => {
    const listener = await start(portFor());

    const view = viewOf(await post(listener));
    const backup = rowOf(view, "backup");

    // Not ACTIVATION_BACKUP_FAILED: nothing failed, nothing was attempted. The code and the
    // layer both name THIS route, because this route is what declined to write.
    expect(backup.code).toBe(ACTIVATION_READ_BACKUP_DEFERRED);
    expect(backup.layer).toBe(READ_LAYER);
    expect(backup.measured).toBe(false);
    expect(backup.ref).toBeNull();
    expect(backup.hash).toBeNull();
    expect(backup.reason).toContain("project.activate");
    // Deferred is not "blocking": only the members a read can actually settle appear there.
    expect([...view.blocking]).toStrictEqual([]);
  });

  it("NEVER reaches the writing ports — no mkdir, no backup, on any number of polls", async () => {
    const { ports, state } = healthyPorts();
    const listener = await start(createActivationReadPort({ input: INPUT, ports }));

    await post(listener);
    await post(listener);
    await post(listener);

    // The fake `backup` THROWS and the fake `fs.mkdir` RECORDS. `readOnlyActivationPorts`
    // replaces both, so neither fires. Delete either replacement and this reds: the throw
    // becomes ACTIVATION_READ_UNREADABLE and mkdirCalls grows one entry per poll.
    expect(state.backupCalls).toStrictEqual([]);
    expect(state.mkdirCalls).toStrictEqual([]);
  });

  it("creates nothing on the REAL filesystem: no .moe-next after repeated reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "moe-activation-read-"));
    scratchRoots.push(root);
    // The REAL node fs bundle, with only git and the durable readers faked: this is the
    // arm that speaks to the operator, whose project root is the one that stays clean.
    const port = createActivationReadPort({
      input: { ...INPUT, projectRoot: root, storePath: join(root, "moe.sqlite") },
      ports: {
        committedProbeRef: () => Promise.resolve("probe/abc"),
        env: {},
        git: () => Promise.resolve(gitOk(HEAD_SHA)),
        installedPolicySliceRefs: () => Promise.resolve([SLICE_A]),
      },
    });
    const listener = await start(port);

    await post(listener);
    await post(listener);

    expect(existsSync(join(root, ".moe-next"))).toBe(false);
    expect(existsSync(join(root, ".moe-next", "backups"))).toBe(false);
  });

  it("reports ONE unmeasurable member with its own code AND child A's layer", async () => {
    // Per member, not a blanket failure: the other four readable members still measure.
    const listener = await start(portFor({
      committedProbeRef: () => Promise.resolve(null),
    }));

    const view = viewOf(await post(listener));
    const provider = rowOf(view, "provider");

    expect(provider.measured).toBe(false);
    expect(provider.code).toBe("ACTIVATION_PROVIDER_UNMEASURED");
    // CHILD A's layer, not the route's: the route must not rewrite whose boundary refused.
    expect(provider.layer).toBe(RECEIPTS_LAYER);
    expect(provider.reason).toBe("no committed provider.probe");
    expect(provider.ref).toBeNull();
    for (const member of ["repository", "store", "distribution", "policy"]) {
      expect(rowOf(view, member).measured).toBe(true);
    }
    expect([...view.blocking]).toStrictEqual(["provider"]);
  });

  it("reports a second unmeasurable member with ITS own code, not the first one's", async () => {
    const listener = await start(portFor({
      installedPolicySliceRefs: () => Promise.resolve([]),
      sqliteApplicationId: () => null,
    }));

    const view = viewOf(await post(listener));

    expect(rowOf(view, "store").code).toBe("ACTIVATION_STORE_UNMEASURED");
    expect(rowOf(view, "policy").code).toBe("ACTIVATION_POLICY_UNMEASURED");
    expect(rowOf(view, "store").layer).toBe(RECEIPTS_LAYER);
    expect(rowOf(view, "policy").layer).toBe(RECEIPTS_LAYER);
    expect([...view.blocking]).toStrictEqual(["store", "policy"]);
    expect(rowOf(view, "repository").measured).toBe(true);
  });

  it("LEAKS NO CREDENTIAL VALUE anywhere in the serialised body", async () => {
    const listener = await start(portFor());

    const reply = await post(listener);

    // The whole wire payload, not a field walk: a leak in ANY reason, ref or nested value
    // is caught. The credential's NAME is the ref the witness carries; its VALUE is not.
    expect(reply.text).not.toContain(CANARY_TOKEN);
    expect(reply.text).not.toContain("sk-ant-");
    expect(JSON.stringify(reply.body)).not.toContain(CANARY_TOKEN);
    // PRESENCE is still reported, so the arm is not passing because the member vanished.
    expect(rowOf(viewOf(reply), "provider").reason)
      .toBe("credential/claude/env:ANTHROPIC_AUTH_TOKEN");
  });

  it("leaks no credential value through a git STDERR tail either", async () => {
    // stderr reaches `reason` verbatim through `receiptDetail`. A runner that echoed its
    // environment would publish the token through the refusal rather than the measurement.
    const listener = await start(portFor({
      git: () => Promise.resolve(gitFail(128, `fatal: env ANTHROPIC_AUTH_TOKEN=${CANARY_TOKEN}`)),
    }));

    const reply = await post(listener);

    expect(rowOf(viewOf(reply), "repository").measured).toBe(false);
    expect(reply.text).not.toContain(CANARY_TOKEN);
  });

  it("marks signing NOT a trust boundary and never a measured receipt", async () => {
    const listener = await start(portFor());

    const reply = await post(listener);
    const view = viewOf(reply);

    expect(view.signing).toStrictEqual({
      measured: false,
      member: "signing",
      reason: "not a trust boundary in v0.1",
      ref: "signing/unsigned-source-checkout",
      trustBoundary: false,
    });
    // And it is NOT one of the six measured members, so no card can render it as one.
    // Compared as strings off the WIRE, because on the typed view the member union already
    // excludes "signing" and the comparison would be a compile-time tautology.
    const wireMembers = (reply.body["members"] as readonly { readonly member: string }[]);
    expect(wireMembers.some((row) => row.member === "signing")).toBe(false);
    expect(wireMembers).toHaveLength(6);
  });

  it("refuses a caller without project.admin with the ROUTE's code at the ROUTE's layer", async () => {
    const listener = await start(portFor());

    const reply = await post(listener, { credential: NO_CAPABILITY_CREDENTIAL });

    expect(reply.body["code"]).toBe("ACTIVATION_READ_CAPABILITY_DENIED");
    expect(reply.body["layer"]).toBe(READ_LAYER);
    expect(reply.body["outcome"]).toBe("REFUSED");
    // Nothing measured leaks to an under-capability caller.
    expect(reply.body["members"]).toBeUndefined();
  });

  it("refuses an unauthenticated caller before any measurement", async () => {
    const { ports, state } = healthyPorts();
    const listener = await start(createActivationReadPort({ input: INPUT, ports }));

    const reply = await post(listener, { credential: null });

    expect(reply.body["outcome"]).not.toBe("ACTIVATION");
    expect(reply.status).not.toBe(200);
    expect(state.mkdirCalls).toStrictEqual([]);
  });

  it("refuses a caller bound to another project, leaking no receipt", async () => {
    const listener = await start(portFor());

    const wellFormed = await post(listener, { credential: FOREIGN_PROJECT_CREDENTIAL });
    const malformed = await post(listener, {
      body: { nonsense: true }, credential: FOREIGN_PROJECT_CREDENTIAL,
    });

    // Guard ORDER, not just guard presence: the binding is checked before the body fence,
    // so a malformed body cannot be used to tell a bound caller from an unbound one.
    expect(wellFormed.body["code"]).toBe("ACTIVATION_READ_PROJECT_MISMATCH");
    expect(wellFormed.body["layer"]).toBe(READ_LAYER);
    expect(malformed.body["code"]).toBe(wellFormed.body["code"]);
  });

  it("refuses a non-POST method — touchpoint 3 of the registration", async () => {
    const listener = await start(portFor());

    const reply = await post(listener, { method: "GET" });

    expect(reply.body["code"]).toBe("LISTENER_ACTIVATION_REQUEST_INVALID");
    expect(reply.status).toBe(400);
  });

  it("refuses a body carrying any operand: this read takes none", async () => {
    const listener = await start(portFor());

    const reply = await post(listener, { body: { projectId: FOREIGN_PROJECT } });

    expect(reply.body["code"]).toBe("LISTENER_ACTIVATION_REQUEST_INVALID");
  });

  it("answers the listener's unavailable code when the port is not composed", async () => {
    const listener = await start();

    const reply = await post(listener);

    expect(reply.body["code"]).toBe("LISTENER_ACTIVATION_UNAVAILABLE");
    expect(reply.status).toBe(503);
  });

  it("inherits the listener's CSRF guard — a new public path is not a bypass", async () => {
    const listener = await start(portFor());

    const reply = await post(listener, { csrf: null });

    expect(reply.body["outcome"]).not.toBe("ACTIVATION");
    expect(reply.body["members"]).toBeUndefined();
  });

  it("turns a THROWN measurement into a coded refusal, not a 500 with a stack", async () => {
    const listener = await start(createActivationReadPort({
      input: INPUT,
      measure: () => Promise.reject(new Error(`boom at ${STORE_PATH} with ${CANARY_TOKEN}`)),
      ports: healthyPorts().ports,
    }));

    const reply = await post(listener);

    expect(reply.body["code"]).toBe("ACTIVATION_READ_UNREADABLE");
    expect(reply.body["layer"]).toBe(READ_LAYER);
    expect(reply.status).toBe(200);
    // The thrown message never reaches the wire: a stack tail is both a leak and noise.
    expect(reply.text).not.toContain(CANARY_TOKEN);
    expect(reply.text).not.toContain("boom");
  });

  it("answers two concurrent reads identically and still writes nothing", async () => {
    const { ports, state } = healthyPorts();
    const listener = await start(createActivationReadPort({ input: INPUT, ports }));

    const [first, second] = await Promise.all([post(listener), post(listener)]);

    expect(first.text).toBe(second.text);
    expect(state.mkdirCalls).toStrictEqual([]);
    expect(state.backupCalls).toStrictEqual([]);
  });

  it("declares exactly three route-local codes, all about the CALLER or the read", () => {
    // A roster arm: a fourth local code — in particular one that collapsed a per-member
    // refusal into a route-level one — reds here rather than passing silently.
    expect([...ACTIVATION_READ_CODES]).toStrictEqual([
      "ACTIVATION_READ_CAPABILITY_DENIED",
      "ACTIVATION_READ_PROJECT_MISMATCH",
      "ACTIVATION_READ_UNREADABLE",
    ]);
  });
});
