import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterAll, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import { handleCommandRequest } from "./http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { ControlRoomListener } from "./http-listener.js";
import { startControlRoomListener } from "./http-listener.js";
import { bytes, envelopeObject } from "./http-test-fixtures.js";

/**
 * task-82c28bf1afa249319bc376fb8f462bd9 (R3-1).
 *
 * The reviewer's escalation: a scoped ADMIN agent requests pairing, approves its OWN
 * confirmation label over the authenticated HTTP route, claims it, and receives the five
 * operator capabilities for twelve hours. ADMIN is a REACH capability - the vocabulary
 * says so - so an ADMIN-only gate on approval never asked WHO was approving.
 *
 * This arm drives that chain through PRODUCTION surfaces on a real socket: a real store
 * from `createStoreDependencies`, a real `session.open` under the configured operator
 * credential, the provider's own authenticator, and the provider's own session-handshake
 * mint wrapped only by a counter. The http-test-fixtures principal helper is deliberately
 * NOT used here: it hardcodes one principal id and so cannot witness an identity fence.
 *
 * Every downstream fence the chain would otherwise trip is cleared on purpose - valid
 * Host, Origin, CSRF, protocol version, exact body, same project, a live pending label
 * and an unexpired OPEN agent session - so the ONLY thing that can refuse the approve
 * call is the admission this row changes.
 */

const CSRF = "pairing-routes-csrf";
const PROJECT_ID = "proj-pairing-routes";
const OPERATOR_CREDENTIAL = "operator-credential-pairing-routes";
const OPERATOR_PRINCIPAL = "operator-local";
const AGENT_SECRET = "agent-session-credential-pairing-routes";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";

const HOSTILE_APPROVAL_CASES = Object.freeze([
  "an ADMIN-holding agent session cannot approve its own pairing over HTTP",
] as const);

const executed: string[] = [];

afterAll(() => {
  // A roster that generated nothing would let every assertion below pass by absence.
  expect(executed).toEqual([...HOSTILE_APPROVAL_CASES]);
});

it("pins the hostile approval roster exact, nonzero, and unique", () => {
  expect(HOSTILE_APPROVAL_CASES).toHaveLength(1);
  expect(HOSTILE_APPROVAL_CASES.length).toBeGreaterThan(0);
  expect(new Set(HOSTILE_APPROVAL_CASES).size).toBe(HOSTILE_APPROVAL_CASES.length);
});

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly raw: string;
  readonly status: number;
}

async function post(
  listener: ControlRoomListener, path: string, body: unknown, credential?: string,
): Promise<Reply> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
    ...(credential === undefined ? {} : { "x-moe-session-credential": credential }),
  };
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(listener.origin + path, { headers, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (raw === "" ? {} : JSON.parse(raw)) as Readonly<Record<string, unknown>>,
          raw,
          status: response.statusCode ?? 0,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

function openSessionCount(storePath: string): number {
  const store = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  try {
    return store.readEvents(`session/${AGENT_SESSION_ID}`).length;
  } finally {
    store.close();
  }
}

const AGENT_SESSION_ID = "session-pairing-routes-agent";

it(HOSTILE_APPROVAL_CASES[0], async () => {
  executed.push(HOSTILE_APPROVAL_CASES[0]);
  const directory = mkdtempSync(join(tmpdir(), "moe-pairing-routes-"));
  const storePath = join(directory, "store.db");
  const setup = SqliteEventStore.openForProject(storePath, PROJECT_ID);
  installTestRecoveryBinding(setup);
  setup.close();

  const provider = createStoreDependencies({
    clock: CLOCK,
    credential: OPERATOR_CREDENTIAL,
    principalId: OPERATOR_PRINCIPAL,
    projectId: PROJECT_ID,
    storePath,
  });
  const logs: string[] = [];
  let listener: ControlRoomListener | null = null;
  try {
    const deps = provider.provide();
    // A REAL agent session: opened through the production command path under the
    // operator credential, exactly as the wrapper opens one for an agent.
    const opened = handleCommandRequest(deps, {
      body: bytes({
        ...envelopeObject({
          commandId: "cmd-session-open-pairing-routes",
          commandKind: "session.open",
          payload: {
            capabilities: [CAPABILITIES.ADMIN, CAPABILITIES.WORK],
            credentialSha256: createHash("sha256").update(AGENT_SECRET, "utf8").digest("hex"),
            // Far future on the REAL clock the authenticator reads: an expired session
            // would be refused by the session authority and this arm would never reach
            // the route it is about.
            expiresAt: "2099-01-01T00:00:00.000Z",
            sessionId: AGENT_SESSION_ID,
          },
          targetAggregateId: `session/${AGENT_SESSION_ID}`,
        }),
        expectedVersion: 0,
        sessionCredential: OPERATOR_CREDENTIAL,
      }),
      credential: OPERATOR_CREDENTIAL,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    expect(opened).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, ok: true, outcome: "ACCEPTED",
    });

    const sessionHandshake = provider.sessionHandshake;
    if (sessionHandshake === undefined) throw new Error("the provider wires no handshake");
    const handshake = sessionHandshake();
    let mintCalls = 0;
    listener = await startAgentListener(deps, handshake, () => { mintCalls += 1; }, logs);

    const requested = await post(listener, "/session/pair/request", {});
    expect(requested.status).toBe(200);
    const confirmationLabel = String(requested.body["confirmationLabel"]);
    const requestId = String(requested.body["requestId"]);

    // The escalation attempt: the agent's own credential, everything else valid.
    const approved = await post(
      listener, "/session/pair/approve", { confirmationLabel }, AGENT_SECRET,
    );
    expect(approved.body).toEqual({
      code: "LISTENER_ROUTE_UNKNOWN", layer: "CONTROL_ROOM_LISTENER",
    });

    const claimed = await post(listener, "/session/pair/claim", { requestId });
    expect(claimed.body).toEqual({
      code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL",
    });
    expect(mintCalls).toBe(0);

    // Secrets are summarised as BOOLEANS before assertion, so a mutant that leaks one
    // never prints it into the report.
    //
    // The REQUEST reply is the one place the label and request id belong - it is how the
    // browser shows the operator a label to type and how it later names its own claim - so
    // it is checked for credentials and capabilities only. Everything else (the refusals
    // this chain produces, and every log line) must carry none of the six.
    const refusals = `${approved.raw}${claimed.raw}${logs.join("\n")}`;
    expect({
      capabilities: refusals.includes("capabilities"),
      credential: refusals.includes(AGENT_SECRET),
      expiresAt: refusals.includes("expiresAt"),
      label: refusals.includes(confirmationLabel),
      operatorCredential: refusals.includes(OPERATOR_CREDENTIAL),
      requestId: refusals.includes(requestId),
    }).toEqual({
      capabilities: false, credential: false, expiresAt: false, label: false,
      operatorCredential: false, requestId: false,
    });
    expect({
      capabilities: requested.raw.includes("capabilities"),
      credential: requested.raw.includes(AGENT_SECRET),
      expiresAt: requested.raw.includes("expiresAt"),
      operatorCredential: requested.raw.includes(OPERATOR_CREDENTIAL),
      sessionCredential: requested.raw.includes("sessionCredential"),
    }).toEqual({
      capabilities: false, credential: false, expiresAt: false,
      operatorCredential: false, sessionCredential: false,
    });

    // The agent session is exactly the one event session.open wrote: no second OPEN row
    // carrying the operator capability set was minted anywhere in the chain.
    expect(openSessionCount(storePath)).toBe(1);
  } finally {
    if (listener !== null) await listener.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

async function startAgentListener(
  deps: Parameters<typeof handleCommandRequest>[0],
  handshake: SessionHandshakePort,
  onMint: () => void,
  logs: string[],
): Promise<ControlRoomListener> {
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    log: (line) => logs.push(line),
    pairing: {
      boundProjectId: handshake.boundProjectId,
      mint: (...args: Parameters<typeof handshake.mint>) => {
        onMint();
        return handshake.mint(...args);
      },
    },
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  return started;
}
