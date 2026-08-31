import { afterAll, expect, it } from "vitest";

import { createPairingApprovalHandshake } from "../../../apps/daemon/src/http/pairing-approval-handshake.js";
import type { PairingClaimed } from "../../../apps/daemon/src/http/pairing-approval-handshake.js";
import { createPairingApprovalWindow } from "../../../apps/daemon/src/http/pairing-approval-window.js";
import {
  createPairingOpenCompletion,
  pairingOpenStatusFor,
} from "../../../apps/daemon/src/http/pairing-open-completion.js";
import { createSessionChallengeOperandsReadPort } from "../../../apps/daemon/src/http/session-challenge-operands-read.js";
import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { OPERATOR_CAPABILITIES } from "../../../apps/daemon/src/daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "../../../apps/daemon/src/identity/session-handshake.js";
import { createSessionAuthority } from "../../../apps/daemon/src/identity/session-authority.js";
import type { SessionAuthorityService } from "../../../apps/daemon/src/identity/session-authority-contracts.js";
import { PROJECT_ID, closeStores, openStore } from "../../../apps/daemon/src/identity/session-test-fixtures.js";
import { resolveLiveSetupFromHandshake } from "../../../apps/control-room/src/live/live-handshake.js";
import type { LiveHandshakeResult, LivePairingPending } from "../../../apps/control-room/src/live/live-handshake.js";

afterAll(() => { closeStores(); });

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const CLAIM_KEYS = Object.freeze(["publicKeySpkiHex", "requestId"]);
const OPEN_KEYS = Object.freeze([
  "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
  "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
]);

interface RealSeam {
  readonly approve: (label: string) => void;
  readonly authority: SessionAuthorityService;
  readonly claim: (body: Readonly<Record<string, unknown>>) => PairingClaimed;
  readonly complete: ReturnType<typeof createPairingOpenCompletion>["complete"];
  readonly request: () => { readonly confirmationLabel: string; readonly requestId: string };
}

interface Journey {
  readonly claimBodies: readonly Readonly<Record<string, unknown>>[];
  readonly claimed: PairingClaimed;
  readonly openBodies: readonly Readonly<Record<string, unknown>>[];
  readonly openWire: unknown;
  readonly outcome: LiveHandshakeResult;
  readonly seam: RealSeam;
}

function realSeam(): RealSeam {
  const store = openStore();
  const window = createPairingApprovalWindow();
  const pairing = createOperatorSessionHandshakePort({
    capabilities: OPERATOR_CAPABILITIES,
    clock: () => Date.now(),
    operatorPrincipalId: "principal-operator-parity",
    projectId: PROJECT_ID,
    sessionTtlMs: 60_000,
    store,
  });
  const operands = createSessionChallengeOperandsReadPort({ projectId: PROJECT_ID, store });
  const handshake = createPairingApprovalHandshake(window.requests, pairing, operands);
  const authority = createSessionAuthority(store, { clock: () => Date.now(), projectId: PROJECT_ID });
  return {
    approve: (label) => {
      const approved = window.operator.approve(label);
      if (!approved.ok) throw new Error("operator approval refused in fixture");
    },
    authority,
    claim: (body) => {
      const outcome = handshake.claim(bytes(JSON.stringify(body)));
      if (!outcome.ok) throw new Error(`daemon refused claim: ${outcome.code}`);
      return outcome;
    },
    complete: createPairingOpenCompletion(authority).complete,
    request: () => {
      const created = handshake.request(bytes("{}"));
      if (!created.ok) throw new Error(`pairing request refused: ${created.code}`);
      return created;
    },
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return {
    headers: new Headers(headers),
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function posted(init?: RequestInit): Readonly<Record<string, unknown>> {
  if (typeof init?.body !== "string") throw new Error("expected JSON body");
  return JSON.parse(init.body) as Readonly<Record<string, unknown>>;
}

function pending(result: LiveHandshakeResult): LivePairingPending {
  if (!("status" in result) || result.status !== "AWAITING_OPERATOR") {
    throw new Error("expected pending pairing");
  }
  return result;
}

async function drive(mode: "KEYED" | "FORCE_BEARER"): Promise<Journey> {
  const seam = realSeam();
  const claimBodies: Readonly<Record<string, unknown>>[] = [];
  const openBodies: Readonly<Record<string, unknown>>[] = [];
  let request: { readonly confirmationLabel: string; readonly requestId: string } | undefined;
  let claimed: PairingClaimed | undefined;
  let openWire: unknown;
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === "/bootstrap") {
      return json({ csrfToken: "csrf-parity", projectId: PROJECT_ID,
        protocolVersion: WIRE_PROTOCOL_VERSION });
    }
    if (path === "/session/pair/request") {
      request = seam.request();
      return json({ ...request, ok: true }, 200, { "x-moe-operator-channel": "true" });
    }
    if (path === "/session/pair/claim") {
      const body = posted(init);
      claimBodies.push(body);
      claimed = mode === "KEYED" ? seam.claim(body) : seam.claim({ requestId: body["requestId"] });
      return json({ ...claimed, protocolVersion: WIRE_PROTOCOL_VERSION });
    }
    if (path === "/session/pair/open") {
      const body = posted(init);
      openBodies.push(body);
      const completed = seam.complete(bytes(JSON.stringify(body)));
      openWire = completed.ok ? { ...completed, protocolVersion: WIRE_PROTOCOL_VERSION } : completed;
      return completed.ok ? json(openWire) : json(openWire, pairingOpenStatusFor(completed.code));
    }
    throw new Error(`unexpected client route ${path}`);
  };
  const pairing = pending(await resolveLiveSetupFromHandshake({ fetchImpl }));
  if (request === undefined) throw new Error("client did not request pairing");
  expect(pairing.confirmationLabel).toBe(request.confirmationLabel);
  seam.approve(pairing.confirmationLabel);
  const outcome = await pairing.claim();
  if (claimed === undefined) throw new Error("client did not claim pairing");
  return { claimBodies, claimed, openBodies, openWire, outcome, seam };
}

it("opens a durable session through the real keyed claim and authority", async () => {
  let keyedCases = 0;
  const journey = await drive("KEYED");
  keyedCases += 1;
  expect(keyedCases).toBe(1);
  expect(journey.claimBodies).toHaveLength(1);
  const claim = journey.claimBodies[0]!;
  expect(Object.keys(claim).toSorted()).toEqual(CLAIM_KEYS);
  expect(claim["publicKeySpkiHex"]).toMatch(/^[0-9a-f]{88}$/u);
  expect(journey.claimed.challenge).toBeDefined();
  expect(Object.keys(journey.claimed.challenge ?? {}).toSorted()).toEqual([
    "keyEpochRef", "profileRevisionId", "recoveryIncarnationRef",
  ]);
  expect(journey.openBodies).toHaveLength(1);
  const open = journey.openBodies[0]!;
  expect(Object.keys(open).toSorted()).toEqual(OPEN_KEYS);
  expect(Object.keys(open["proof"] as Readonly<Record<string, unknown>>).toSorted()).toEqual([
    "algorithm", "issuedAt", "nonce", "protocolVersion", "signatureHex",
  ]);
  expect(journey.openWire).toEqual({ ok: true, protocolVersion: WIRE_PROTOCOL_VERSION,
    sessionId: open["sessionId"] });
  expect("ok" in journey.outcome && journey.outcome.ok).toBe(true);
  if (!("ok" in journey.outcome) || !journey.outcome.ok) throw new Error("expected live setup");
  expect(journey.outcome.sessionCredential).toBe(journey.claimed.sessionCredential);
  const durable = journey.seam.authority.readSessionAuthority(open["sessionId"]);
  expect(durable.status).toBe("FOUND");
  if (durable.status !== "FOUND") throw new Error("durable authority not found");
  expect(durable.authority.session.sessionId).toBe(open["sessionId"]);
  expect(durable.authority.publicKey.clientKeyId).toBe(open["clientKeyId"]);
  expect(durable.authority.publicKey.publicKeySpkiHex).toBe(claim["publicKeySpkiHex"]);
  expect(JSON.stringify({ claim, open, outcome: journey.outcome })).not.toContain("privateKey");
});

it("refuses the real bearer claim divergence before signed open", async () => {
  const journey = await drive("FORCE_BEARER");
  expect(journey.claimBodies).toHaveLength(1);
  expect(Object.keys(journey.claimBodies[0]!).toSorted()).toEqual(CLAIM_KEYS);
  expect(journey.claimed.challenge).toBeUndefined();
  expect(journey.outcome).toEqual({
    code: "LIVE_PAIRING_REFUSED", detail: "session pairing challenge refused", ok: false,
  });
  expect(journey.openBodies).toHaveLength(0);
  expect(journey.openWire).toBeUndefined();
});
