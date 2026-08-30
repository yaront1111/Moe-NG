/**
 * The operator-principal fence, measured under a REAL paired HUMAN session.
 *
 * Operator ruling 2026-08-30 (task-6093483c comment-18dc557c): a session minted by
 * the approved-pairing seam — a durable HUMAN principal — is the approver seat for
 * `approval.decide_intent`. Everything else on `OPERATOR_PRINCIPAL_KINDS` keeps the
 * configured-operator fence: an agent/scoped session stays 403 on the intent kind,
 * and even the paired HUMAN stays 403 on `goal.close` (the widening is one kind,
 * not a seat upgrade).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandKind } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { OPERATOR_CAPABILITIES } from "./daemon-command-vocabulary.js";
import { createOperatorSessionHandshakePort } from "./identity/session-handshake.js";
import { isDurableHumanPrincipal } from "./identity/human-approver.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";

const CREDENTIAL = "human-approver-operator-credential";
const PROJECT = "proj-human-approver";
const DECIDED_AT = "2026-08-30T12:00:00.000Z";
const CLOCK = (): string => DECIDED_AT;

const directory = mkdtempSync(join(tmpdir(), "moe-human-approver-"));
const storePath = join(directory, "store.db");

// One real approved-pairing mint, committed durably BEFORE the provider opens: a
// HUMAN principal record plus an open session whose credential the authenticator
// reads back from the same store. This is the production browser-pairing shape,
// not a fixture spelling of it.
const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
const minted = createOperatorSessionHandshakePort({
  capabilities: OPERATOR_CAPABILITIES,
  clock: () => Date.parse(DECIDED_AT),
  operatorPrincipalId: "operator-human-approver",
  projectId: PROJECT,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  store: setupStore,
}).mint();
if (!minted.ok) throw new Error(`pairing mint refused in fixture: ${minted.code}`);
const PAIRED_CREDENTIAL = minted.credential;
const PAIRED_PRINCIPAL_ID = minted.principalId;
setupStore.close();

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-human-approver",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function send(
  commandId: string,
  commandKind: RuntimeCommandKind,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-human-approver", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-human-approver",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

function openScopedSession(
  commandId: string, sessionId: string, secret: string, capabilities: readonly string[],
): string {
  const opened = send(commandId, "session.open", {
    capabilities,
    credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z",
    sessionId,
  });
  expect(opened).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
  return secret;
}

describe("paired HUMAN principal at the operator fence", () => {
  it("records the pairing mint as a durable HUMAN principal (fixture positive control)", () => {
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      expect(isDurableHumanPrincipal(reader, PAIRED_PRINCIPAL_ID)).toBe(true);
      expect(isDurableHumanPrincipal(reader, "principal-that-never-was")).toBe(false);
    } finally {
      reader.close();
    }
  });

  it("admits the paired HUMAN session past the fence on approval.decide_intent", () => {
    // On HEAD this refused 403 OPERATOR_PRINCIPAL_REQUIRED — the browser could
    // never approve. Past the fence the intent seam answers with its OWN refusal
    // (payload/record stage); which one is that seam's business, not this fence's.
    const outcome = send("cmd-human-intent", "approval.decide_intent", {}, PAIRED_CREDENTIAL);
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toMatchObject({ httpStatus: 403 });
    const code = (outcome as { refusal?: { code?: string }; error?: { code?: string } });
    expect(code.refusal?.code ?? code.error?.code).not.toBe("OPERATOR_PRINCIPAL_REQUIRED");
  });

  it("keeps a scoped non-HUMAN session behind the fence on approval.decide_intent", () => {
    const secret = openScopedSession(
      "cmd-open-scoped", "sess-scoped-agent", "secret-scoped-agent",
      ["planning.write", "work.write"],
    );
    expect(send("cmd-agent-intent", "approval.decide_intent", {}, secret)).toMatchObject({
      httpStatus: 403,
      ok: false,
      refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" },
    });
  });

  it("keeps even the paired HUMAN behind the fence on goal.close (one kind, not a seat)", () => {
    expect(send("cmd-human-goal-close", "goal.close", {}, PAIRED_CREDENTIAL)).toMatchObject({
      httpStatus: 403,
      ok: false,
      refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" },
    });
  });

  it("leaves the configured operator's own path untouched", () => {
    const outcome = send("cmd-operator-intent", "approval.decide_intent", {});
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toMatchObject({ httpStatus: 403 });
    const code = (outcome as { refusal?: { code?: string }; error?: { code?: string } });
    expect(code.refusal?.code ?? code.error?.code).not.toBe("OPERATOR_PRINCIPAL_REQUIRED");
  });
});
