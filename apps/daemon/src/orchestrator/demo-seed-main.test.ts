import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { NODE_DELIVER_KIND } from "../http/affordance-contract.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import { BOARD_PROJECTION } from "../projections/board-projection-contracts.js";
import {
  MOE_SEED_COMMIT_TIMEOUT,
  MOE_SEED_COMMIT_UNOBSERVABLE,
  MOE_SEED_NODE_NOT_READY,
  MOE_SEED_TRANSPORT_FAILED,
  runDemoSeed,
} from "./demo-seed-main.js";
import type { FetchLike } from "./demo-seed-main.js";
import { MOE_SEED_ENV_MISSING } from "./demo-seed-env.js";
import { DEMO_SEED_KINDS } from "./demo-seed-plan.js";

/**
 * The client is exercised over a REAL loopback HTTP server, so the header set and
 * the commit-before-next ordering are observed on the wire rather than asserted
 * against an injected double that could agree with a mistake.
 */

const NODE_REF = "node-code-1";
const CREDENTIAL = "operator-credential";
const CSRF = "csrf-token";

const specsDir = mkdtempSync(join(tmpdir(), "moe-seed-specs-"));
writeFileSync(
  join(specsDir, "demo-node.json"),
  JSON.stringify({
    instructions: "Create math.mjs exporting add and multiply so test.mjs passes.",
    nodeRef: NODE_REF,
    test: "node test.mjs",
    title: "Implement the math module",
    workspace: "D:/demo/workspace",
  }),
  "utf8",
);

afterAll(() => {
  try {
    rmSync(specsDir, { force: true, recursive: true });
  } catch {
    // A held handle on Windows must not redden a suite that already answered.
  }
});

interface Recorded {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly path: string;
}

interface StubOptions {
  /** Refuse the command at this index with this frame, status 409. */
  readonly commandRefusal?: { readonly at: number; readonly frame: unknown };
  /** Polls a fresh commit stays invisible for: the delayed-commit arm. */
  readonly commitDelayPolls?: number;
  /** Answer ACCEPTED with no effectId: an accepted-but-unobservable commit. */
  readonly effectlessCommands?: boolean;
  /** Answer REPLAYED and serve NO events: a second seed over one store. */
  readonly replayedCommands?: boolean;
  readonly eventsRefusal?: unknown;
  readonly nodeStatus?: string;
  /** Events served per page; a smaller page forces the ack/pagination path. */
  readonly pageSize?: number;
}

interface Stub {
  readonly close: () => Promise<void>;
  readonly origin: string;
  readonly requests: readonly Recorded[];
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: Recorded[] = [];
  const committed: { commandId: string; polls: number }[] = [];
  const dispatched: string[] = [];
  let acked = 0;
  let commandCount = 0;

  const send = (response: ServerResponse, status: number, frame: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(frame));
  };

  /**
   * Mirrors the frames a live daemon served during the smoke: a row names its
   * effect through `identity.commandId` = `moe-internal:decision-effect:<effectId>`
   * and carries no plain commandId, and the page stays a PENDING OFFER until the
   * exact cursor is acknowledged — so a client that never acks reads the same page
   * forever and never sees the next commit.
   */
  const eventsFrame = (): unknown => {
    for (const entry of committed) entry.polls += 1;
    const delay = options.commitDelayPolls ?? 0;
    const visible = committed.filter((entry) => entry.polls > delay);
    const size = options.pageSize ?? Math.max(visible.length - acked, 1);
    const page = visible.slice(acked, acked + Math.max(size, 1));
    return {
      checkpoint: String(acked + page.length),
      events: page.map((entry, index) => ({
        aggregateId: "aggregate-1",
        committedAt: "2026-08-18T00:00:00.000Z",
        eventId: `${entry.commandId}-Committed`,
        eventType: "Committed",
        globalPosition: String(acked + index + 1),
        identity: {
          commandId: `moe-internal:decision-effect:effect-${entry.commandId}`,
          principal: { known: true, value: "operator-local" },
        },
      })),
      hasMore: acked + page.length < visible.length,
      nextCursor: { generation: 1, position: String(acked + page.length) },
      outcome: "PAGE",
    };
  };

  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "";
      requests.push({ body, headers: request.headers, path });
      if (path === "/command") {
        const index = commandCount;
        commandCount += 1;
        if (options.commandRefusal !== undefined && options.commandRefusal.at === index) {
          send(response, 409, options.commandRefusal.frame);
          return;
        }
        dispatched.push(String(body["commandId"]));
        if (options.replayedCommands !== true) {
          committed.push({ commandId: String(body["commandId"]), polls: 0 });
        }
        send(response, 200, {
          decision: {
            commandId: String(body["commandId"]),
            disposition: options.replayedCommands === true ? "REPLAYED" : "DECIDED",
            effectId: options.effectlessCommands === true
              ? null
              : `effect-${String(body["commandId"])}`,
            resultCode: "EFFECTS_COMMITTED",
          },
          httpStatus: 200,
          ok: true,
          outcome: "ACCEPTED",
        });
        return;
      }
      if (path === "/events/read") {
        send(response, 200, options.eventsRefusal ?? eventsFrame());
        return;
      }
      if (path === "/events/ack") {
        const cursor = body["presentedCursor"] as { position?: string } | undefined;
        acked = Number(cursor?.position ?? acked);
        send(response, 200, { cursor, outcome: "ACKNOWLEDGED" });
        return;
      }
      if (path === "/affordances/read") {
        const approved = dispatched.some((id) => id.endsWith("approval.decide"));
        send(response, 200, {
          nextAllowedCommands: [],
          outcome: "SURFACE",
          steps: approved
            ? [{
              aggregateId: NODE_REF,
              claim: null,
              claimAggregateVersion: 0,
              kind: NODE_DELIVER_KIND,
              missing: [],
              status: options.nodeStatus ?? "READY",
              version: 0,
            }]
            : [],
        });
        return;
      }
      send(response, 404, { code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

const envFor = (origin: string, overrides: Record<string, string | undefined> = {}) => ({
  MOE_CSRF_TOKEN: CSRF,
  MOE_DAEMON_CREDENTIAL: CREDENTIAL,
  MOE_DAEMON_ORIGIN: origin,
  MOE_NODE_SPECS_DIR: specsDir,
  MOE_PROJECT_ID: "demo-project",
  ...overrides,
});

const runAgainst = async (stub: Stub, overrides: Record<string, string | undefined> = {}) => {
  const lines: string[] = [];
  const outcome = await runDemoSeed({
    clock: () => "2026-08-18T00:00:00.000Z",
    env: envFor(stub.origin, overrides),
    fetch: globalThis.fetch as unknown as FetchLike,
    log: (line) => lines.push(line),
    pollAttempts: 8,
    pollDelayMs: 1,
  });
  return { lines, outcome };
};

describe("runDemoSeed against a loopback daemon stub", () => {
  it("seeds the chain and reports a READY node with every dispatched id", async () => {
    const stub = await startStub();
    try {
      const { lines, outcome } = await runAgainst(stub);

      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.line}`);
      expect(outcome.nodeRef).toBe(NODE_REF);
      expect(outcome.commandIds).toEqual([
        "demo-seed-project.register",
        "demo-seed-project.bind_repository",
        "demo-seed-provider.probe",
        "demo-seed-project.activate",
        "demo-seed-policy.install-verifier-policy",
        "demo-seed-policy.install-reviewer-calibration",
        "demo-seed-policy.install-validatable-policy",
        "demo-seed-goal.create",
        "demo-seed-plan.propose",
        "demo-seed-plan.propose-finalize",
        "demo-seed-approval.decide",
      ]);
      expect(lines.some((line) => line.includes(`READY ${NODE_DELIVER_KIND}@${NODE_REF}`))).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("treats a REPLAYED decision as already durable instead of awaiting a second event", async () => {
    const stub = await startStub({ replayedCommands: true });
    try {
      const { lines, outcome } = await runAgainst(stub);
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.line}`);

      expect(outcome.commandIds.length).toBe(DEMO_SEED_KINDS.length);
      expect(lines.some((line) => line.includes("replayed project.register"))).toBe(true);
      // It never polled the stream for an event the seam will not re-issue.
      expect(stub.requests.filter((recorded) => recorded.path === "/events/read")).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("sends the exact header set the listener guards demand, on every route", async () => {
    const stub = await startStub();
    try {
      const { outcome } = await runAgainst(stub);
      if (!outcome.ok) throw new Error(outcome.line);

      expect(stub.requests.length).toBeGreaterThan(0);
      for (const recorded of stub.requests) {
        expect({
          csrf: recorded.headers["x-moe-csrf"],
          origin: recorded.headers["origin"],
          path: recorded.path,
          protocol: recorded.headers["x-moe-protocol-version"],
          session: recorded.headers["x-moe-session-credential"],
        }).toEqual({
          csrf: CSRF,
          origin: stub.origin,
          path: recorded.path,
          protocol: WIRE_PROTOCOL_VERSION,
          session: CREDENTIAL,
        });
      }
    } finally {
      await stub.close();
    }
  });

  it("reads the board projection under the only subscriber the daemon registers", async () => {
    const stub = await startStub();
    try {
      const { outcome } = await runAgainst(stub);
      if (!outcome.ok) throw new Error(outcome.line);
      const reads = stub.requests.filter((recorded) => recorded.path === "/events/read");

      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect({ projection: read.body["projection"], subscriber: read.body["subscriberId"] })
          .toEqual({ projection: BOARD_PROJECTION, subscriber: "control-room-1" });
      }
    } finally {
      await stub.close();
    }
  });

  it("waits for each durable commit before sending the next command", async () => {
    const stub = await startStub({ commitDelayPolls: 2 });
    try {
      const { outcome } = await runAgainst(stub);
      if (!outcome.ok) throw new Error(outcome.line);

      // Every /command after the first is preceded by a read that carried the
      // PREVIOUS command's commit — the ordering clause, observed on the wire.
      const commands = stub.requests.filter((recorded) => recorded.path === "/command");
      expect(commands.length).toBe(DEMO_SEED_KINDS.length);
      let checked = 0;
      for (let index = 1; index < commands.length; index += 1) {
        const previousId = String(commands[index - 1]?.body["commandId"]);
        const sentAt = stub.requests.indexOf(commands[index] as Recorded);
        const sawCommit = stub.requests
          .slice(0, sentAt)
          .filter((recorded) => recorded.path === "/events/read").length;
        checked += 1;
        expect({ id: previousId, polled: sawCommit > 0 }).toEqual({ id: previousId, polled: true });
      }
      expect(checked).toBe(DEMO_SEED_KINDS.length - 1);
      // The delay forced real polling rather than a single lucky read.
      expect(stub.requests.filter((r) => r.path === "/events/read").length)
        .toBeGreaterThan(DEMO_SEED_KINDS.length);
    } finally {
      await stub.close();
    }
  });

  it("pages through the ledger, acknowledging the cursor it was issued", async () => {
    const stub = await startStub({ pageSize: 1 });
    try {
      const { outcome } = await runAgainst(stub);
      if (!outcome.ok) throw new Error(outcome.line);

      expect(stub.requests.some((recorded) => recorded.path === "/events/ack")).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe("runDemoSeed refusals", () => {
  it("echoes a command refusal's code and layer and sends nothing after it", async () => {
    const stub = await startStub({
      commandRefusal: {
        at: 3,
        frame: {
          httpStatus: 409,
          ok: false,
          outcome: "PORT_REFUSED",
          refusal: {
            code: "STORE_VERSION_CONFLICT",
            detail: "expected version 2",
            httpStatus: 409,
            layer: "STATE",
          },
          stage: "DISPATCH",
        },
      },
    });
    try {
      const { outcome } = await runAgainst(stub);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.code).toBe("STORE_VERSION_CONFLICT");
      expect(outcome.line).toContain("STORE_VERSION_CONFLICT");
      expect(outcome.line).toContain("layer=STATE");
      expect(outcome.line).toContain("project.activate");
      expect(stub.requests.filter((recorded) => recorded.path === "/command").length).toBe(4);
    } finally {
      await stub.close();
    }
  });

  it("echoes an event-stream refusal verbatim instead of waiting it out", async () => {
    const stub = await startStub({
      eventsRefusal: {
        code: "SUBSCRIPTION_NOT_REGISTERED",
        detail: "seed-1 has no durable subscription",
        layer: "STATE",
        outcome: "REFUSED",
      },
    });
    try {
      const { outcome } = await runAgainst(stub);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.code).toBe("SUBSCRIPTION_NOT_REGISTERED");
      expect(outcome.line).toContain("layer=STATE");
    } finally {
      await stub.close();
    }
  });

  it("times out by name when a commit never lands, rather than hanging", async () => {
    const stub = await startStub({ commitDelayPolls: 99 });
    try {
      const { outcome } = await runAgainst(stub);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a timeout refusal");
      expect(outcome.code).toBe(MOE_SEED_COMMIT_TIMEOUT);
      expect(outcome.line).toContain("demo-seed-project.register");
    } finally {
      await stub.close();
    }
  });

  it("reports the surface's own status when the node is not READY", async () => {
    const stub = await startStub({ nodeStatus: "BLOCKED" });
    try {
      const { outcome } = await runAgainst(stub);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected a not-ready refusal");
      expect(outcome.code).toBe(MOE_SEED_NODE_NOT_READY);
      expect(outcome.line).toContain("status=BLOCKED");
    } finally {
      await stub.close();
    }
  });

  it("names the missing variable and touches the network not at all", async () => {
    const stub = await startStub();
    try {
      const { outcome } = await runAgainst(stub, { MOE_DAEMON_CREDENTIAL: undefined });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected an env refusal");
      expect(outcome.code).toBe(MOE_SEED_ENV_MISSING);
      expect(outcome.line).toContain("MOE_DAEMON_CREDENTIAL");
      expect(outcome.line).not.toContain(CREDENTIAL);
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("refuses an accepted command whose commit it cannot observe", async () => {
    const stub = await startStub({ effectlessCommands: true });
    try {
      const { outcome } = await runAgainst(stub);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected an unobservable-commit refusal");
      expect(outcome.code).toBe(MOE_SEED_COMMIT_UNOBSERVABLE);
      expect(outcome.line).toContain("project.register");
      // It stopped at the first one rather than firing the rest blind.
      expect(stub.requests.filter((recorded) => recorded.path === "/command").length).toBe(1);
    } finally {
      await stub.close();
    }
  });

  it("names a dead daemon as a transport failure instead of hanging", async () => {
    const stub = await startStub();
    const origin = stub.origin;
    await stub.close();
    const outcome = await runDemoSeed({
      clock: () => "2026-08-18T00:00:00.000Z",
      env: envFor(origin),
      fetch: globalThis.fetch as unknown as FetchLike,
      log: () => undefined,
      pollAttempts: 2,
      pollDelayMs: 1,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a transport refusal");
    expect(outcome.code).toBe(MOE_SEED_TRANSPORT_FAILED);
    expect(outcome.line).toContain("/command");
  });
});
