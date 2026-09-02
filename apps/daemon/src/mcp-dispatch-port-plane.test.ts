import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { activateV2Directly } from "./cutover/v2-activation-test-fixtures.js";
import { createStoreDependencies } from "./daemon-store-foundation-composition.js";
import type { CommandAuthorityPlanePort } from "./http/http-contract.js";
import { DAEMON_COMMAND_SEAM } from "./http/http-async-contract.js";
import { MCP_V2_COMMAND_UNAVAILABLE, createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { wiredMcpToolKinds } from "./mcp-tool-allowlist.js";

/**
 * The MCP port FOLLOWS THE PLANE. Every world here is the shipped composition over a real
 * temp store — `createStoreDependencies` builds both registries and the plane reader — and
 * nothing decides the plane but the durable cutover marker. The subject is what ONE port
 * instance answers before and after that marker commits, because an agent session outlives
 * the activation and a port that captured its deps at start would strand it.
 */
const CREDENTIAL = "mcp-plane-operator-credential";
const CLOCK = (): string => "2026-09-02T12:00:00.000Z";

interface World {
  /** Decisions committed by DISPATCHES here: the count above the composition's boot writes. */
  readonly decisions: () => number;
  readonly project: string;
  readonly provider: ReturnType<typeof createStoreDependencies>;
  readonly store: SqliteEventStore;
}
const closers: (() => void)[] = [];

function world(label: string): World {
  const project = `proj-mcp-plane-${label}`;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `moe-mcp-plane-${label}-`)));
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: CLOCK, credential: CREDENTIAL, principalId: "operator-local", projectId: project,
    storePath,
  });
  const store = SqliteEventStore.openForProject(storePath, project);
  closers.push(() => {
    store.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  });
  // DELTA from the composition's own boot writes: the shipped provider commits one
  // decision at open, so a raw count would read that as a dispatch.
  const baseline = store.readCommandDecisionsAfter(0n, 1_000).items.length;
  return {
    decisions: () => store.readCommandDecisionsAfter(0n, 1_000).items.length - baseline,
    project, provider, store,
  };
}

afterAll(() => { for (const close of closers) close(); });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decode = (bytes: Uint8Array): Record<string, unknown> =>
  JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;

/**
 * `session.open` is the probe: operator-only, ACCEPTED on a fresh store with no other
 * seeding, and registered on BOTH planes, so the only thing that changes its answer
 * across the flip is which plane's gate admits it.
 */
function sessionOpenBytes(sessionId: string): Uint8Array {
  const payload = {
    capabilities: ["work.write"],
    credentialSha256: createHash("sha256").update(`cred-${sessionId}`, "utf8").digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z",
    sessionId,
  };
  return encoder.encode(JSON.stringify({
    commandId: `cmd-${sessionId}`,
    commandKind: "session.open",
    correlationId: `corr-${sessionId}`,
    expectedVersion: 0,
    payload,
    requestDigest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: CREDENTIAL,
    targetAggregateId: `session/${sessionId}`,
  }));
}

function planeFollowingPort(opened: World, plane?: CommandAuthorityPlanePort) {
  const subscriptions = opened.provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
  return createMcpDispatchPort({
    commandAuthorityPlane: plane ?? opened.provider.commandAuthorityPlane?.(),
    deps: opened.provider.provide(),
    fallbackCredential: CREDENTIAL,
    subscriptions,
    v2Deps: opened.provider.provideV2?.(),
  });
}

const ACCEPTED = { ok: true, outcome: "ACCEPTED" };
const RETIRED = {
  ok: false, outcome: "PORT_REFUSED", refusal: { code: "V1_AUTHORITY_RETIRED" }, stage: "DISPATCH",
};

describe("the MCP dispatch port follows the command authority plane per dispatch", () => {
  it("flips ONE port instance from /1 to /2 the moment the marker commits", async () => {
    const opened = world("flip");
    const port = planeFollowingPort(opened);

    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("before")))).toMatchObject(ACCEPTED);
    expect(opened.decisions()).toBe(1);

    activateV2Directly(opened.store, opened.project);

    // THE SAME PORT, nothing rebuilt: the answer is the /2 plane's, one decision, and
    // not the retirement the /1 plane now answers (the control arm below proves that).
    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("after")))).toMatchObject(ACCEPTED);
    expect(opened.decisions()).toBe(2);
  });

  it("CONTROL: a port composed without the plane (the prior shape) is stranded on /1", async () => {
    const opened = world("stranded");
    const subscriptions = opened.provider.subscriptions?.();
    if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
    const stranded = createMcpDispatchPort({
      deps: opened.provider.provide(), fallbackCredential: CREDENTIAL, subscriptions,
    });
    activateV2Directly(opened.store, opened.project);
    expect(decode(await stranded.dispatchCommandBytes(sessionOpenBytes("stranded"))))
      .toMatchObject({ ...RETIRED, httpStatus: 422 });
    expect(opened.decisions()).toBe(0);
  });

  it("reads the plane on EVERY dispatch and routes each one by that read", async () => {
    // A V2 read on a store where /2 is NOT active is refused by the /2 registry's own gate,
    // which is what proves the /2 deps were the ones consulted and not the /1 deps.
    const opened = world("per-call");
    const answers = ["V1", "V2", "V1"] as const;
    let reads = 0;
    const port = planeFollowingPort(opened, Object.freeze({
      boundProjectId: opened.project,
      readPlane: () => answers[Math.min(reads++, answers.length - 1)] ?? "V1",
    }));

    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("one")))).toMatchObject(ACCEPTED);
    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("two")))).toMatchObject({
      ok: false, outcome: "PORT_REFUSED",
      refusal: { code: "CUTOVER_V2_NOT_ACTIVE", layer: "DAEMON_CUTOVER_V2_AUTHORITY" },
      stage: "DISPATCH",
    });
    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("three")))).toMatchObject(ACCEPTED);
    expect(reads).toBe(3);
    expect(opened.decisions()).toBe(2);
  });

  it("refuses a V2 dispatch when no /2 deps were composed, and never falls back to /1", async () => {
    const opened = world("unavailable");
    const subscriptions = opened.provider.subscriptions?.();
    if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
    const port = createMcpDispatchPort({
      commandAuthorityPlane: Object.freeze({ boundProjectId: opened.project, readPlane: () => "V2" }),
      deps: opened.provider.provide(),
      fallbackCredential: CREDENTIAL,
      subscriptions,
    });
    expect(decode(await port.dispatchCommandBytes(sessionOpenBytes("unavailable")))).toEqual({
      httpStatus: 503,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: MCP_V2_COMMAND_UNAVAILABLE,
        detail: "the durable cutover marker names the /2 plane and this MCP host composed none",
        httpStatus: 503,
        layer: DAEMON_COMMAND_SEAM,
      },
      stage: "DISPATCH",
    });
    // The /1 registry would have ACCEPTED this envelope: zero decisions proves it never ran.
    expect(opened.decisions()).toBe(0);
  });

  it("throws on a plane outside the roster rather than coercing it to /1", async () => {
    const opened = world("invalid");
    const port = planeFollowingPort(opened, Object.freeze({
      boundProjectId: opened.project,
      readPlane: () => "V3" as unknown as "V1",
    }));
    await expect(port.dispatchCommandBytes(sessionOpenBytes("invalid")))
      .rejects.toThrow("COMMAND_AUTHORITY_PLANE_INVALID");
    expect(opened.decisions()).toBe(0);
  });

  it("answers the /2 roster's OWN refusal for the one advertised kind /2 withholds", async () => {
    // `planning.submit_decomposition` is advertised (the roster derives from the /1
    // vocabulary) and withheld on /2 by design. After the flip an agent calling it must
    // get the /2 registry's exact, visible refusal — not a quiet fallback to the retired
    // /1 handler, which would ACCEPT it under a plane that no longer holds authority.
    const opened = world("withheld");
    const port = planeFollowingPort(opened);
    activateV2Directly(opened.store, opened.project);
    expect(wiredMcpToolKinds()).toContain("planning.submit_decomposition");
    const payload = { decomposition: {} };
    const answer = decode(await port.dispatchCommandBytes(encoder.encode(JSON.stringify({
      commandId: "cmd-withheld", commandKind: "planning.submit_decomposition",
      correlationId: "corr-withheld", expectedVersion: 0, payload,
      requestDigest: createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: CREDENTIAL,
      targetAggregateId: "planning-withheld",
    }))));
    expect(answer).toMatchObject({ error: { code: "INPUT_INVALID" }, ok: false, stage: "REGISTRY" });
    expect(opened.decisions()).toBe(0);
  });
});
