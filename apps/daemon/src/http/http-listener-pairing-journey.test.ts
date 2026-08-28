import { request as httpRequest } from "node:http";

import { expect, it, vi } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { ControlRoomListener } from "./http-listener.js";
import { startControlRoomListener } from "./http-listener.js";
import {
  GOOD_CREDENTIAL,
  authenticator,
  decisionPort,
  recordingHandler,
  registryOf,
} from "./http-test-fixtures.js";

const CSRF = "pairing-journey-csrf";
const PROJECT_ID = "proj-0001";

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface RequestOptions {
  readonly body: string;
  readonly credential?: string;
  readonly path: string;
}

interface PairingIdentity {
  readonly confirmationLabel: string;
  readonly requestId: string;
}

async function post(listener: ControlRoomListener, options: RequestOptions): Promise<Reply> {
  const headers = {
    "content-length": String(Buffer.byteLength(options.body)),
    "content-type": "application/json",
    host: `127.0.0.1:${listener.port}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    ...(options.credential === undefined
      ? {}
      : { "x-moe-session-credential": options.credential }),
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  return await new Promise((resolve, reject) => {
    const request = httpRequest(listener.origin + options.path, {
      headers, method: "POST",
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

async function startJourneyListener(
  mint: SessionHandshakePort["mint"],
  monotonicNow: () => number,
  logs: string[],
): Promise<ControlRoomListener> {
  const handler = recordingHandler();
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps: {
      authenticator: authenticator([CAPABILITIES.ADMIN]),
      decisions: decisionPort(),
      registry: registryOf("goal.create", handler.handler, ["title"]),
    },
    log: (line) => logs.push(line),
    pairing: { boundProjectId: PROJECT_ID, mint },
    pairingMonotonicNow: monotonicNow,
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  return started;
}

function identityOf(reply: Reply): PairingIdentity {
  const confirmationLabel = reply.body["confirmationLabel"];
  const requestId = reply.body["requestId"];
  if (typeof confirmationLabel !== "string" || typeof requestId !== "string") {
    throw new Error("pairing request did not return its bounded identity");
  }
  return Object.freeze({ confirmationLabel, requestId });
}

function expectRefusal(reply: Reply, code: string): void {
  expect(reply.body).toEqual({ code, layer: "CONTROL_ROOM_PAIRING_APPROVAL" });
  expect(reply.body).not.toHaveProperty("requestId");
  expect(reply.body).not.toHaveProperty("confirmationLabel");
  expect(reply.body).not.toHaveProperty("sessionCredential");
}

it("binds approved socket claims exactly once and discloses secrets only in named successes", async () => {
  let now = 1;
  let mintCalls = 0;
  let failNextMint = false;
  const mintedCredentials: string[] = [];
  const mint: SessionHandshakePort["mint"] = vi.fn(() => {
    mintCalls += 1;
    if (failNextMint) {
      failNextMint = false;
      return Object.freeze({ code: "SESSION_STORE_UNAVAILABLE", ok: false as const });
    }
    const credential = `minted-session-${mintCalls}`;
    mintedCredentials.push(credential);
    return Object.freeze({
      capabilities: Object.freeze([CAPABILITIES.ADMIN]),
      credential,
      expiresAt: "2026-08-26T20:00:00.000Z",
      ok: true as const,
    });
  });
  const logs: string[] = [];
  const observedPaths: string[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    stdoutWrites.push(String(chunk)); return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk): boolean => {
    stderrWrites.push(String(chunk)); return true;
  });
  const started = await startJourneyListener(mint, () => now, logs);
  let foreign: ControlRoomListener | null = null;
  const identities: PairingIdentity[] = [];
  const successfulClaims: Reply[] = [];
  const otherReplies: Reply[] = [];
  const send = async (target: ControlRoomListener, options: RequestOptions): Promise<Reply> => {
    observedPaths.push(options.path);
    return await post(target, options);
  };
  const requestPair = async (target: ControlRoomListener): Promise<PairingIdentity> => {
    const response = await send(target, { body: "{}", path: "/session/pair/request" });
    expect(response.body).not.toHaveProperty("sessionCredential");
    const identity = identityOf(response);
    identities.push(identity);
    return identity;
  };
  // task-82c28bf1: the operator approves through the PRIVATE seam its terminal line
  // reaches (daemon-main.ts feeds stdin into exactly this call), never over HTTP. The
  // journey below is otherwise unchanged, so it still witnesses the legitimate path.
  const approve = (identity: PairingIdentity): void => {
    expect(started.approvePairing(identity.confirmationLabel))
      .toEqual({ ok: true, state: "APPROVED" });
  };
  const claim = async (identity: PairingIdentity): Promise<Reply> => await send(started, {
    body: JSON.stringify({ requestId: identity.requestId }), path: "/session/pair/claim",
  });
  const refused = (reply: Reply, code: string): void => {
    expectRefusal(reply, code);
    otherReplies.push(reply);
  };
  try {
    const victim = await requestPair(started);
    const attacker = await requestPair(started);
    approve(victim);
    refused(await claim(attacker), "PAIRING_APPROVAL_REQUIRED");
    const victimClaim = await claim(victim);
    successfulClaims.push(victimClaim);
    expect(victimClaim.body["sessionCredential"]).toBe("minted-session-1");
    expect(mintCalls).toBe(1);
    refused(await claim(victim), "PAIRING_REQUEST_ALREADY_CLAIMED");

    const victimTwo = await requestPair(started);
    const attackerTwo = await requestPair(started);
    approve(attackerTwo);
    refused(await claim(victimTwo), "PAIRING_APPROVAL_REQUIRED");
    successfulClaims.push(await claim(attackerTwo));

    const concurrent = await requestPair(started);
    approve(concurrent);
    const racingClaims = await Promise.all([claim(concurrent), claim(concurrent)]);
    const raceWinner = racingClaims.find((reply) => reply.status === 200);
    const raceLoser = racingClaims.find((reply) => reply.status !== 200);
    if (raceWinner === undefined || raceLoser === undefined) throw new Error("claim race lacked a winner");
    successfulClaims.push(raceWinner);
    refused(raceLoser, "PAIRING_REQUEST_ALREADY_CLAIMED");

    const mismatched = await send(started, {
      body: JSON.stringify({ requestId: "../foreign" }), path: "/session/pair/claim",
    });
    refused(mismatched, "PAIRING_CLAIM_REQUEST_INVALID");
    foreign = await startJourneyListener(mint, () => now, logs);
    refused(await claim(await requestPair(foreign)), "PAIRING_REQUEST_UNKNOWN");
    const expired = await requestPair(started);
    now += 60_001;
    refused(await claim(expired), "PAIRING_REQUEST_EXPIRED");

    const failedMint = await requestPair(started);
    const bystander = await requestPair(started);
    approve(failedMint);
    approve(bystander);
    failNextMint = true;
    refused(await claim(failedMint), "PAIRING_SESSION_MINT_FAILED");
    successfulClaims.push(await claim(bystander));
    successfulClaims.push(await claim(failedMint));
    expect(mintCalls).toBe(6);

    const legacyBearer = "legacy-pairing-bearer-secret";
    otherReplies.push(await send(started, {
      body: JSON.stringify({ pairingToken: legacyBearer }), path: "/session/pair",
    }));
    const identitySecrets = identities.flatMap((value) => [value.requestId, value.confirmationLabel]);
    const unsafeText = [
      ...stdoutWrites, ...stderrWrites, ...logs, ...observedPaths, ...process.argv,
      ...otherReplies.map((reply) => JSON.stringify(reply.body)),
    ].join("\n");
    for (const secret of [GOOD_CREDENTIAL, legacyBearer, ...identitySecrets, ...mintedCredentials]) {
      expect(unsafeText).not.toContain(secret);
    }
    const successfulClaimText = successfulClaims.map((reply) => JSON.stringify(reply.body)).join("\n");
    for (const credential of mintedCredentials) {
      expect(successfulClaimText.split(credential)).toHaveLength(2);
    }
    for (const secret of identitySecrets) expect(successfulClaimText).not.toContain(secret);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (foreign !== null) await foreign.close();
    await started.close();
  }
});
