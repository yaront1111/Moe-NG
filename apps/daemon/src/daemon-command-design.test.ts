/**
 * `design.submit` and `design.read` ARE SEAT KINDS -- the inversion this row exists for.
 *
 * Every other kind this epic publishes is a HUMAN act: a null `agentCapabilitiesFor`, a seat in
 * `OPERATOR_PRINCIPAL_KINDS`, the MCP exclusion derived from it, an entry in `HUMAN_ONLY_STEPS`.
 * The design step is the opposite -- an AGENT authors the design and seats read it back -- so
 * copying the surrounding pattern would leave every roster test in this repository green while
 * the design step became PERMANENTLY UNSTAFFABLE. The chain would simply never advance.
 *
 * SO EVERY ARM HERE IS BEHAVIOURAL, NOT A MEMBERSHIP CHECK. `expect(agentCapabilitiesFor(k))
 * .not.toBeNull()` would restate the constant and would still pass if the registry's own
 * capability fence refused the seat one layer down. Instead the submit arms MINT A SESSION
 * WHOSE CAPABILITIES ARE READ OUT OF `agentCapabilitiesFor` AT RUN TIME and dispatch through
 * the production seam: make that function answer null the way `product_contract
 * .answer_clarification` does and the session cannot be opened at all, so the arm reds. That is
 * the drill this file is written to fail.
 *
 * NOTHING HERE HAND-BUILDS AUTHORITY. The world is the production journey -- `boundWorld` ->
 * `committedRevision` -> `approveGate1` -- so a green submit proves the command edge reached the
 * real aggregate through a real Gate 1 approval, not that a fixture was echoed back.
 *
 * WINDOWS HANDLE DISCIPLINE: every store comes from the shared fixture pool and is closed by
 * `closeStores()` in `afterAll`, matching `design-store.test.ts`.
 */
import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterAll, describe, expect, it } from "vitest";
import type { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, closeStores } from "./bootstrap/bootstrap-test-fixtures.js";
import { DESIGN_CODE_LAYERS } from "./design/design-contracts.js";
import { designRevisionFixture } from "./design/design-test-fixtures.js";
import { readDesignRevision } from "./design/design-store.js";
import {
  OPERATOR_CAPABILITIES, createDaemonCommandPorts,
} from "./daemon-command-registry.js";
import { DESIGN_SUBMIT_RESULT_CODE } from "./daemon-command-design.js";
import { CAPABILITIES, OPERATOR_PRINCIPAL_KINDS, agentCapabilitiesFor }
  from "./daemon-command-vocabulary.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { answerDesignReadQuery } from "./mcp-design-read-query.js";
import { MCP_EXCLUDED_COMMAND_KINDS, MCP_SERVED_QUERY_KINDS } from "./mcp-tool-allowlist.js";
import { servedMcpQueryKinds } from "./mcp-dispatch-port.js";
import { HUMAN_ONLY_STEPS } from "./orchestrator/agent-spawn-contract.js";
import { OPERATOR, approveGate1, boundWorld, committedRevision }
  from "./planning/plan-reject-test-fixtures.js";

afterAll(closeStores);

const CREDENTIAL = "design-operator-credential";
const NOW = "2026-09-06T00:00:00.000Z";
const encoder = new TextEncoder();

interface World {
  readonly contractRef: unknown;
  readonly deps: CommandAdapterDeps;
  readonly store: SqliteEventStore;
}

/** The production journey, then the production ports over the SAME store. */
function designWorld(): World {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  const ports = createDaemonCommandPorts({
    clock: () => NOW, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
  });
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.parse(NOW),
    operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: CREDENTIAL,
    operatorPrincipalId: OPERATOR,
    projectId: PROJECT_ID,
  });
  return {
    contractRef: ref,
    deps: Object.freeze({ authenticator, decisions: ports.decisions, registry: ports.registry }),
    store,
  };
}

function send(
  deps: CommandAdapterDeps,
  commandId: string,
  commandKind: string,
  payload: Readonly<Record<string, unknown>>,
  credential: string = CREDENTIAL,
): ReturnType<typeof handleCommandRequest> {
  return handleCommandRequest(deps, {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind, correlationId: "corr-design", expectedVersion: 0, payload,
      requestDigest: "a".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: `design:${GOAL_ID}`,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }, "HTTP_LISTENER");
}

/**
 * A SEAT session, capabilities READ OUT OF PRODUCTION rather than transcribed.
 *
 * This is the drill hook. `agentCapabilitiesFor` returning null -- the human-only shape every
 * kind neighbouring `design.submit` uses -- throws HERE, before any dispatch, so every arm that
 * needs a seat reds. A hard-coded `[PLANNING, WORK]` would have kept them all green while the
 * wrapper's own staffing gate (`orchestrator/agent-wrapper.ts:178`) answered UNWIRED_KIND and
 * no seat was ever minted for the design step.
 */
function seatSession(
  deps: CommandAdapterDeps, kind: string, sessionId: string, secret: string,
): string {
  const capabilities = agentCapabilitiesFor(kind);
  if (capabilities === null) {
    throw new Error(`${kind} is unstaffable: agentCapabilitiesFor answered null`);
  }
  return openSession(deps, sessionId, secret, capabilities);
}

function openSession(
  deps: CommandAdapterDeps, sessionId: string, secret: string, capabilities: readonly string[],
): string {
  const opened = send(deps, `cmd-open-${sessionId}`, "session.open", {
    capabilities: [...capabilities],
    credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z",
    sessionId,
  });
  expect(opened).toMatchObject({ decision: { disposition: "DECIDED" }, outcome: "ACCEPTED" });
  return secret;
}

describe("design.submit is reachable by a seat", () => {
  it("commits an AGENT-authenticated submit through the production command seam", () => {
    const world = designWorld();
    const seat = seatSession(world.deps, "design.submit", "sess-design-seat", "secret-design");

    const answer = send(world.deps, "cmd-design-submit", "design.submit", {
      contractRef: world.contractRef, goalRef: GOAL_ID, revision: designRevisionFixture(),
    }, seat);

    // REACHED THE HANDLER, and went all the way to the aggregate. A capability refusal would
    // have answered CAPABILITY_DENIED at AUTHORIZE and never called the edge at all.
    expect(answer).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: DESIGN_SUBMIT_RESULT_CODE },
      outcome: "ACCEPTED",
    });
    // The durable proof, read back through the production reader rather than the response.
    const read = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`design read refused: ${read.code}`);
    expect(read.record.version).toBe(1);
    expect(read.record.revision).toEqual(designRevisionFixture());
    expect(read.versions).toEqual([1]);
  });

  it("refuses a seat that holds no capability for it, at AUTHORIZE and not at the edge", () => {
    // The other half of "reachable": reach must still be FENCED. A session holding only WORK
    // never reaches the design edge, so the refusal names the seam and not the design slice.
    const world = designWorld();
    const weak = openSession(world.deps, "sess-design-weak", "secret-weak", [CAPABILITIES.WORK]);

    const refused = send(world.deps, "cmd-design-weak", "design.submit", {
      contractRef: world.contractRef, goalRef: GOAL_ID, revision: designRevisionFixture(),
    }, weak);

    expect(refused).toMatchObject({
      error: { code: "CAPABILITY_DENIED" }, ok: false, outcome: "REFUSED", stage: "AUTHORIZE",
    });
    expect(readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID }))
      .toMatchObject({ code: "DESIGN_REVISION_ABSENT", ok: false });
  });

  it("answers a malformed submit with the design slice's OWN code and its mapped layer", () => {
    const world = designWorld();
    const seat = seatSession(world.deps, "design.submit", "sess-design-shape", "secret-shape");

    const refused = send(world.deps, "cmd-design-shape", "design.submit", {
      contractRef: world.contractRef, goalRef: GOAL_ID, revision: { missing: "sections" },
    }, seat);

    // The code AND the layer, and the layer is asserted from the slice's closed map rather than
    // a literal -- `designRefusal` derives it, so a call site cannot mint a disagreeing pair.
    expect(refused).toMatchObject({
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: {
        code: "DESIGN_SHAPE_INVALID", layer: DESIGN_CODE_LAYERS.DESIGN_SHAPE_INVALID,
      },
      stage: "DISPATCH",
    });
  });
});

describe("design.read is answered for a seat over MCP", () => {
  it("returns the revision to an AGENT-authenticated caller", () => {
    const world = designWorld();
    const seat = seatSession(world.deps, "design.submit", "sess-design-read", "secret-read");
    expect(send(world.deps, "cmd-design-read-seed", "design.submit", {
      contractRef: world.contractRef, goalRef: GOAL_ID, revision: designRevisionFixture(),
    }, seat)).toMatchObject({ outcome: "ACCEPTED" });

    const bytes = answerDesignReadQuery({
      authenticator: world.deps.authenticator,
      body: { goalRef: GOAL_ID },
      credential: seat,
      port: { read: (input) => readDesignRevision(world.store, input) },
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });

    const answer = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(answer["ok"]).toBe(true);
    expect(answer["record"]).toMatchObject({
      goalRef: GOAL_ID, projectId: PROJECT_ID, revision: designRevisionFixture(), version: 1,
    });
  });

  it("refuses an unauthenticated caller before it decides anything about the payload", () => {
    const world = designWorld();

    const bytes = answerDesignReadQuery({
      authenticator: world.deps.authenticator,
      body: { goalRef: GOAL_ID },
      credential: null,
      port: { read: (input) => readDesignRevision(world.store, input) },
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });

    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ ok: false });
  });

  it("is BOTH advertised and served -- an entry on one side alone promises a phantom tool", () => {
    expect(MCP_SERVED_QUERY_KINDS).toContain("design.read");
    expect(servedMcpQueryKinds()).toContain("design.read");
  });
});

describe("neither design kind wears the human-only fence", () => {
  it("keeps design.submit off every operator-only surface", () => {
    // Three places habit would put it, named one by one because each has its own consequence:
    // the dispatch fence, the MCP advertisement DERIVED from it, and the wrapper's staffing
    // skip list. Any one of them alone makes the design step unstaffable.
    expect(OPERATOR_PRINCIPAL_KINDS.has("design.submit")).toBe(false);
    expect(MCP_EXCLUDED_COMMAND_KINDS).not.toContain("design.submit");
    expect(HUMAN_ONLY_STEPS.has("design.submit")).toBe(false);
    expect(HUMAN_ONLY_STEPS.has("design.read")).toBe(false);
  });

  it("hands a seat a real capability set for design.submit, ordered and frozen", () => {
    const capabilities = agentCapabilitiesFor("design.submit");
    expect(capabilities).toEqual([CAPABILITIES.PLANNING, CAPABILITIES.WORK]);
    expect(Object.isFrozen(capabilities)).toBe(true);
    // The control that makes the line above mean something: the human-only shape it must NOT
    // have, read off a kind that genuinely wears it.
    expect(agentCapabilitiesFor("product_contract.answer_clarification")).toBeNull();
  });
});
