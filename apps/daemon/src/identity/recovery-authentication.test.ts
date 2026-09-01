import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  RECOVERY_BINDING_CODEC_VERSION,
  SqliteEventStore,
} from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { handleCommandRequest } from "../http/http-adapter.js";
import {
  WIRE_PROTOCOL_VERSION,
  buildCommandRegistry,
} from "../http/http-contract.js";
import type {
  CommandAdapterDeps,
  CommandDecisionPort,
  DurableDecision,
  HttpCommandResult,
} from "../http/http-contract.js";
import { createSessionAuthenticator } from "./session-authenticator.js";
import { readSessionLedger } from "./session-read-model.js";
import {
  EXPIRES_AT_MS,
  PROJECT_ID,
  closeStores,
  commitRaw,
  envelope,
  hashOf,
  openPayload,
  openStore,
  openUnboundStore,
  send,
} from "./session-test-fixtures.js";

const encoder = new TextEncoder();
const BINDING_PAYLOAD = encoder.encode("same-backup-generation");
const PAIRS = Object.freeze([
  { incarnation: "11".repeat(32), keyEpoch: "21".repeat(32) },
  { incarnation: "12".repeat(32), keyEpoch: "22".repeat(32) },
  { incarnation: "13".repeat(32), keyEpoch: "23".repeat(32) },
]);
const CREDENTIALS = ["old-bearer-one", "old-bearer-two", "current-bearer-three"] as const;
const OPERATOR_CREDENTIAL = "operator-recovery-bootstrap";

afterEach(closeStores);

function install(store: SqliteEventStore, pair: (typeof PAIRS)[number]): void {
  const result = store.installRecoveryBinding({
    bindingCodecVersion: RECOVERY_BINDING_CODEC_VERSION,
    incarnationRef: pair.incarnation,
    installedAt: "2026-08-12T00:00:00.000Z",
    keyEpochRef: pair.keyEpoch,
    payload: BINDING_PAYLOAD,
    slot: "ACTIVE",
  });
  expect(result).toMatchObject({ ok: true, outcome: "INSTALLED" });
}

function openBearer(
  store: SqliteEventStore,
  index: number,
  options: {
    readonly capabilities?: readonly string[];
    readonly credential?: string;
    readonly expiresAt?: string;
  } = {},
): void {
  const result = send(store, envelope(
    "session.open",
    0,
    openPayload({
      capabilities: options.capabilities ?? ["goal.write"],
      credentialSha256: hashOf(options.credential ?? CREDENTIALS[index]!),
      expiresAt: options.expiresAt ?? new Date(EXPIRES_AT_MS + 60_000).toISOString(),
      sessionId: `recovery-session-${String(index + 1)}`,
    }),
    `cmd-open-recovery-${String(index + 1)}`,
  ));
  expect(result).toMatchObject({ ok: true });
}

interface Counts {
  decisions: number;
  handlers: number;
}

function httpDeps(store: SqliteEventStore, counts: Counts): CommandAdapterDeps {
  const decisions: CommandDecisionPort = {
    decide(_key, _digest, commit) {
      counts.decisions += 1;
      return { decision: commit(), outcome: "DECIDED" };
    },
  };
  return {
    authenticator: createSessionAuthenticator(store, {
      clock: () => EXPIRES_AT_MS,
      operatorCapabilities: ["admin.bootstrap"],
      operatorCredential: OPERATOR_CREDENTIAL,
      operatorPrincipalId: "operator-recovery",
      projectId: PROJECT_ID,
    }),
    decisions,
    registry: buildCommandRegistry([{
      handler: ({ envelope: command }): DurableDecision => {
        counts.handlers += 1;
        return {
          commandId: command.commandId,
          disposition: "DECIDED",
          effectId: "effect-recovery",
          resultCode: "EFFECTS_COMMITTED",
        };
      },
      kind: "goal.create",
      payloadKeys: ["title"],
      requiredCapability: "goal.write",
    }]),
  };
}

function body(credential: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: `command-${credential}`,
    commandKind: "goal.create",
    correlationId: "correlation-recovery",
    expectedVersion: 0,
    payload: { title: "recovery fence" },
    requestDigest: "a".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: credential,
    targetAggregateId: "goal-recovery",
  }));
}

function request(credential: string | null, requestBody: unknown = body(credential ?? "none")) {
  return { body: requestBody, credential, protocolVersion: WIRE_PROTOCOL_VERSION };
}

function expectGenericFailure(result: HttpCommandResult): void {
  expect(result).toMatchObject({
    error: { code: "AUTHENTICATION_FAILED" },
    httpStatus: 401,
    outcome: "REFUSED",
    stage: "AUTHENTICATE",
  });
}

describe("recovery-bound bearer ingress", () => {
  it("refuses exactly two earlier installs before expiry, capability, decode, or effect", () => {
    const store = openStore();
    install(store, PAIRS[0]!);
    openBearer(store, 0, { expiresAt: new Date(EXPIRES_AT_MS - 1).toISOString() });
    install(store, PAIRS[1]!);
    openBearer(store, 1, { capabilities: [] });
    install(store, PAIRS[2]!);
    openBearer(store, 2);

    const ledger = readSessionLedger(store, PROJECT_ID);
    expect(ledger.sessions.get("recovery-session-3")).toMatchObject({
      keyEpochRef: PAIRS[2]!.keyEpoch,
      recoveryIncarnationRef: PAIRS[2]!.incarnation,
    });

    const counts = { decisions: 0, handlers: 0 };
    const deps = httpDeps(store, counts);
    for (const credential of CREDENTIALS.slice(0, 2)) {
      expect(deps.authenticator.authenticate(credential)).toMatchObject({
        refusal: { code: "SESSION_REPLAYED", httpStatus: 401, layer: "IDENTITY" },
        verdict: "REFUSED",
      });
    }
    expect(deps.authenticator.authenticate(CREDENTIALS[2])).toMatchObject({
      verdict: "AUTHENTICATED",
    });
    const stale = CREDENTIALS.slice(0, 2).map((credential) =>
      handleCommandRequest(deps, request(credential, Uint8Array.from([0x7b, 0xff])), "HTTP_LISTENER"));
    expect(stale).toHaveLength(2);
    for (const result of stale) {
      expect(result).toMatchObject({
        httpStatus: 401,
        outcome: "PORT_REFUSED",
        refusal: { code: "SESSION_REPLAYED", layer: "IDENTITY" },
        stage: "AUTHENTICATE",
      });
    }
    expect(counts).toEqual({ decisions: 0, handlers: 0 });

    expect(handleCommandRequest(deps, request(CREDENTIALS[2]), "HTTP_LISTENER")).toMatchObject({
      httpStatus: 200,
      outcome: "ACCEPTED",
    });
    expect(counts).toEqual({ decisions: 1, handlers: 1 });

    const serialized = JSON.stringify(stale);
    for (const secret of [...CREDENTIALS, "proof", "signature", "privateKey", "handle", "nonce",
      "same-backup-generation"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps malformed, unknown, ambiguous, and legacy-unbound bearers generic", () => {
    const store = openStore();
    install(store, PAIRS[2]!);
    openBearer(store, 0);
    openBearer(store, 1, { credential: CREDENTIALS[0] });
    const counts = { decisions: 0, handlers: 0 };
    const deps = httpDeps(store, counts);

    for (const credential of [null, "", "unknown-bearer", CREDENTIALS[0]]) {
      expectGenericFailure(handleCommandRequest(deps, request(credential), "HTTP_LISTENER"));
    }

    const legacyStore = openStore();
    install(legacyStore, PAIRS[2]!);
    const legacyFacts = openPayload({
      expiresAt: new Date(EXPIRES_AT_MS + 60_000).toISOString(),
    });
    commitRaw(
      legacyStore,
      envelope("session.open", 0, legacyFacts, "cmd-open-legacy"),
      { ...legacyFacts, principalId: "legacy-opener" },
      "session-alpha",
    );
    expectGenericFailure(handleCommandRequest(
      httpDeps(legacyStore, { decisions: 0, handlers: 0 }),
      request("client-generated-bearer-credential-alpha"), "HTTP_LISTENER",
    ));
    expect(counts).toEqual({ decisions: 0, handlers: 0 });
  });

  it("grants no bootstrap authority when ACTIVE is absent or unreadable", () => {
    const absent = openUnboundStore();
    expectGenericFailure(handleCommandRequest(
      httpDeps(absent, { decisions: 0, handlers: 0 }),
      request(OPERATOR_CREDENTIAL), "HTTP_LISTENER",
    ));

    const directory = mkdtempSync(join(tmpdir(), "moe-recovery-auth-corrupt-"));
    const path = join(directory, "store.sqlite");
    const corrupt = SqliteEventStore.openForProject(path, PROJECT_ID);
    try {
      install(corrupt, PAIRS[2]!);
      const database = new DatabaseSync(path);
      try {
        database.prepare("UPDATE recovery_bindings SET binding_bytes = ? WHERE slot = ?")
          .run(Uint8Array.of(0), "ACTIVE");
      } finally {
        database.close();
      }
      expect(corrupt.readRecoveryBinding("ACTIVE")).toMatchObject({
        code: "RECOVERY_BINDING_DIGEST_MISMATCH",
        ok: false,
      });
      expectGenericFailure(handleCommandRequest(
        httpDeps(corrupt, { decisions: 0, handlers: 0 }),
        request(OPERATOR_CREDENTIAL), "HTTP_LISTENER",
      ));
    } finally {
      corrupt.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reads the selected binding again for every operator and session decision", () => {
    const store = openStore();
    install(store, PAIRS[0]!);
    openBearer(store, 0);
    const authenticator = httpDeps(store, { decisions: 0, handlers: 0 }).authenticator;

    expect(authenticator.authenticate(CREDENTIALS[0])).toMatchObject({
      verdict: "AUTHENTICATED",
    });
    expect(authenticator.authenticate(OPERATOR_CREDENTIAL)).toMatchObject({
      verdict: "AUTHENTICATED",
    });

    install(store, PAIRS[1]!);
    expect(authenticator.authenticate(CREDENTIALS[0])).toMatchObject({
      refusal: { code: "SESSION_REPLAYED", layer: "IDENTITY" },
      verdict: "REFUSED",
    });
    expect(authenticator.authenticate(OPERATOR_CREDENTIAL)).toMatchObject({
      verdict: "AUTHENTICATED",
    });
  });
});
