/**
 * The AUTHORITY ORDER in front of the five graph mutation kinds, driven through the real HTTP
 * adapter, the real `Authenticator` and a real file-backed `SqliteEventStore` (task-931f99e8).
 *
 * ORDER IS ASSERTED, NOT JUST OUTCOME. `prepareCommand` is authenticate -> compatibility ->
 * decode -> registry -> authorize -> payload shape, so every arm below sends a payload that
 * WOULD refuse at PAYLOAD_SHAPE and asserts the EARLIER stage answered. A test that sent a
 * well-formed payload could not tell an ordering violation from a correct refusal: the
 * discriminator is that the later stage did NOT speak.
 *
 * ZERO RESIDUE, MEASURED. Every pre-service arm pins the decision-row count across the call, so
 * a refusal that nevertheless reached a service and committed would red here rather than pass as
 * "it was refused".
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
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { GRAPH_SERVER_OWNED_REQUEST_KEYS } from "./daemon-command-graph-contracts.js";
import {
  GRAPH_MUTATION_COMMAND_KINDS, OPERATOR_PRINCIPAL_KINDS, PAYLOAD_KEYS,
} from "./daemon-command-vocabulary.js";
import type { GraphMutationCommandKind } from "./daemon-command-vocabulary.js";

const PLANNING = "planning.write";
const WORK = "work.write";
const CREDENTIAL = "graph-authority-operator-credential";
const PROJECT = "proj-graph-authority";
const CLOCK = (): string => "2026-08-09T12:00:00.000Z";

/** The served kinds, taken from the production roster so a dropped kind shrinks the sweep. */
const KINDS: readonly GraphMutationCommandKind[] = GRAPH_MUTATION_COMMAND_KINDS;

/**
 * The two kinds the human fence closes over, hand-transcribed rather than filtered out of the
 * production set: filtering would make this list agree with whatever the set happens to say.
 */
const HUMAN_ONLY: readonly GraphMutationCommandKind[] = ["graph.approve", "graph.supersede"];

/** A key no allow-list carries, so PAYLOAD_SHAPE is the stage that WOULD answer. */
const HOSTILE = Object.freeze({ smuggled: true });

const directory = mkdtempSync(join(tmpdir(), "moe-graph-authority-"));
const storePath = join(directory, "store.db");

const setupStore = SqliteEventStore.openForProject(storePath, PROJECT);
installTestRecoveryBinding(setupStore);
setupStore.close();

const provider = createStoreDependencies({
  clock: CLOCK,
  credential: CREDENTIAL,
  principalId: "operator-local",
  projectId: PROJECT,
  storePath,
});
const deps = provider.provide();

afterAll(() => {
  provider.close();
  rmSync(directory, { force: true, recursive: true });
});

function send(
  commandId: string, commandKind: RuntimeCommandKind,
  payload: Readonly<Record<string, unknown>>, credential: string = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: new TextEncoder().encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-graph-authority", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: "agg-graph-authority",
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

function openSession(
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

function decisionCount(): number {
  const reader = SqliteEventStore.openForProject(storePath, PROJECT);
  try {
    return reader.readCommandDecisionsAfter(0n, 1_000).items.length;
  } finally {
    reader.close();
  }
}

const planningSession = openSession(
  "cmd-graph-sess-planning", "sess-graph-planning", "secret-graph-planning", [PLANNING, WORK],
);
const workOnlySession = openSession(
  "cmd-graph-sess-work", "sess-graph-work", "secret-graph-work", [WORK],
);

describe("graph mutation ingress pins its own denominators (task-931f99e8)", () => {
  it("sweeps exactly five kinds, two of them human-only, over five server-owned keys", () => {
    expect(KINDS).toHaveLength(5);
    expect(new Set(KINDS).size).toBe(5);
    expect(HUMAN_ONLY).toHaveLength(2);
    expect(GRAPH_SERVER_OWNED_REQUEST_KEYS).toHaveLength(5);
    // BOTH DIRECTIONS over the human fence: a graph kind added to the operator set reddens on
    // the three that must stay open, one dropped reddens on the two that must not.
    for (const kind of KINDS) {
      expect(OPERATOR_PRINCIPAL_KINDS.has(kind)).toBe(HUMAN_ONLY.includes(kind));
    }
  });
});

describe("the Authenticator answers before any graph payload is read (task-931f99e8)", () => {
  it.each(KINDS)(
    "%s refuses an UNAUTHENTICATED caller at AUTHENTICATE, never at PAYLOAD_SHAPE",
    (kind) => {
      const before = decisionCount();
      const refused = send(
        `cmd-unauth-${kind}`, kind, HOSTILE, "not-a-credential-anyone-minted",
      );
      // PAYLOAD_SHAPE is STRICTLY LATER than AUTHENTICATE, and this payload would refuse there.
      // Reading it first would answer INPUT_INVALID and leak the allow-list to a stranger.
      expect(refused).toMatchObject({ ok: false, stage: "AUTHENTICATE" });
      expect(refused).not.toMatchObject({ stage: "PAYLOAD_SHAPE" });
      expect(decisionCount()).toBe(before);
    },
  );

  it.each(KINDS)("%s refuses a caller WITHOUT planning.write at AUTHORIZE", (kind) => {
    const before = decisionCount();
    const refused = send(`cmd-nocap-${kind}`, kind, HOSTILE, workOnlySession);
    expect(refused).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, httpStatus: 403, ok: false,
      outcome: "REFUSED", stage: "AUTHORIZE",
    });
    expect(decisionCount()).toBe(before);
  });

  it.each(KINDS)("%s lets the capability holder REACH payload shape", (kind) => {
    const before = decisionCount();
    const refused = send(`cmd-shape-${kind}`, kind, HOSTILE, planningSession);
    // The positive control for the two arms above: without it, an ingress that refused
    // everything at AUTHORIZE would satisfy them both.
    expect(refused).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false,
      outcome: "REFUSED", stage: "PAYLOAD_SHAPE",
    });
    expect(decisionCount()).toBe(before);
  });
});

describe("no caller may present a SERVER-owned request member (task-931f99e8)", () => {
  const CASES = KINDS.flatMap((kind) => GRAPH_SERVER_OWNED_REQUEST_KEYS.map((key) => ({
    key, kind,
  })));

  it("generates a case for every kind and every server-owned key", () => {
    // A sweep that silently produced zero cases would pass while testing nothing.
    expect(CASES).toHaveLength(25);
  });

  it.each(CASES)("$kind refuses a payload naming $key, structurally", ({ key, kind }) => {
    const before = decisionCount();
    const refused = send(`cmd-owned-${kind}-${key}`, kind, { [key]: "caller-chosen" },
      planningSession);
    expect(refused).toMatchObject({
      error: { code: "INPUT_INVALID" }, httpStatus: 400, ok: false, stage: "PAYLOAD_SHAPE",
    });
    expect(PAYLOAD_KEYS[kind]).not.toContain(key);
    expect(decisionCount()).toBe(before);
  });
});

describe("the human fence sits above the capability fence (task-931f99e8)", () => {
  it.each(HUMAN_ONLY)(
    "%s refuses a planning-capable SESSION with the operator code and no residue",
    (kind) => {
      const before = decisionCount();
      const refused = send(`cmd-operator-${kind}`, kind, {}, planningSession);
      expect(refused).toMatchObject({
        httpStatus: 403, ok: false, outcome: "PORT_REFUSED",
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION" },
        stage: "DISPATCH",
      });
      expect(decisionCount()).toBe(before);
    },
  );

  it.each(KINDS.filter((kind) => !HUMAN_ONLY.includes(kind)))(
    "%s admits a planning-capable session all the way to its own service",
    (kind) => {
      const before = decisionCount();
      const refused = send(`cmd-open-${kind}`, kind, {}, planningSession);
      // The service's OWN code answers, which is what proves the human fence is closed over
      // exactly two kinds rather than over the family.
      expect(refused).toMatchObject({ outcome: "PORT_REFUSED", stage: "DISPATCH" });
      expect(refused).not.toMatchObject({
        refusal: { code: "OPERATOR_PRINCIPAL_REQUIRED" },
      });
      expect(decisionCount()).toBe(before);
    },
  );
});
