/**
 * THE HUMAN-ONLY FENCE, HELD FOR THE WHOLE SET AT ONCE.
 *
 * Each band row asserted its OWN kind's fence. Nothing asserted the SET, and a kind added to two
 * of the three rosters is precisely the defect class that minted 8 junk goals live
 * (`orchestrator/agent-spawn-contract.ts:198-205`). So every arm here enumerates the band kinds
 * from the DISPATCH SEAM -- the composed registry's keys -- and never from a hand list, because a
 * hand list cannot contain the kind that was forgotten.
 *
 * THE THREE AXES, and why each is read where it is:
 *   1. OPERATOR-PRINCIPAL-ONLY -- `OPERATOR_PRINCIPAL_KINDS` (daemon-command-vocabulary.ts).
 *   2. MCP-EXCLUDED -- asserted against `wiredMcpToolKinds()`, the ACTUAL served-over-MCP surface
 *      (mcp-tool-allowlist.ts:99). NOT against `MCP_EXCLUDED_COMMAND_KINDS`, which is DERIVED
 *      from axis 1 (:96) -- that comparison would be circular and would pass with the fence
 *      broken.
 *   3. HUMAN_ONLY_STEPS -- the wrapper's staffing fence, ONE Set at agent-spawn-contract.ts:195
 *      re-exported by agent-wrapper.ts. Several task descriptions on this board still claim it is
 *      duplicated byte-for-byte; that claim is stale and was re-measured for this row.
 *
 * THE INVARIANT IS ALL-THREE-OR-NONE-OF-THREE, per band kind, reporting WHICH axis disagreed.
 * That is stronger than "the human gates are fenced": it also catches a kind fenced on two axes
 * -- the leak -- without needing to know in advance which side of the line it belongs on.
 * `design.submit` sits on the OTHER side deliberately (daemon-command-vocabulary.ts:200-217:
 * copying the human shape there would make the design step PERMANENTLY UNSTAFFABLE), and the
 * invariant admits it as 0/3 rather than forcing a wrong assertion.
 *
 * THE HUMAN FLOOR below is a FLOOR and can only fail closed: it names the gates this epic shipped
 * as human acts, so REMOVING a fence from any of them reds. A brand-new band kind landing
 * unfenced on all three axes would satisfy the invariant; the floor is what a later row extends,
 * and the refusal arms are what prove the fence is real rather than declared.
 *
 * AND THE REFUSAL NAMES ITS LAYER. Every dispatch arm opens the agent session with the registry
 * entry's OWN `requiredCapability`, so the capability gate CANNOT answer first: a test asserting
 * only "refused" is one added layer away from vacuous.
 */
import { createHash } from "node:crypto";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore }
  from "./bootstrap/bootstrap-test-fixtures.js";
import { createDaemonCommandPorts } from "./daemon-command-registry.js";
import { OPERATOR_CAPABILITIES, OPERATOR_PRINCIPAL_KINDS } from "./daemon-command-vocabulary.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { handleAsyncCommandRequest, handleCommandRequest } from "./http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { wiredMcpToolKinds } from "./mcp-tool-allowlist.js";
import { HUMAN_ONLY_STEPS } from "./orchestrator/agent-spawn-contract.js";

afterEach(closeStores);

const BAND = /^(?:design|preview|release)\./u;
const CREDENTIAL = "fence-operator-credential";
const NOW = "2026-09-08T12:00:00.000Z";
/** The principal the bootstrap fixture world runs as; the authenticator refuses a credential
 *  minted for any other id with AUTHENTICATION_FAILED @ AUTHENTICATE. */
const OPERATOR = "principal-1";
const encoder = new TextEncoder();

/** The gates this epic shipped as HUMAN acts. A floor, never a ceiling: the invariant arm below
 *  enumerates from the seam, and this only refuses a SILENT UNFENCING of a shipped gate. */
const HUMAN_GATE_FLOOR: readonly string[] = Object.freeze([
  "preview.decide", "preview.start", "release.decide",
]);
/** Shipped as a SEAT kind on purpose, and asserted as such so a future "tidy-up" that fenced it
 *  would red here instead of making the design step permanently unstaffable. */
const SEAT_KIND = "design.submit";

/** The exact pair every human-gate refusal must carry. Both halves, never just the outcome. */
const OPERATOR_FENCE = Object.freeze({
  code: "OPERATOR_PRINCIPAL_REQUIRED", layer: "DAEMON_AUTHORIZATION",
});

type Composed = ReturnType<typeof createDaemonCommandPorts>;

interface Ports {
  readonly deps: CommandAdapterDeps;
  readonly registry: Composed["registry"];
}

function ports(): Ports {
  const store = openStore();
  // The project must be REGISTERED and ACTIVE before a session can be minted at all: a bare
  // store refuses `session.open` and every arm below would fail on the fixture, not the fence.
  installTestRecoveryBinding(store);
  driveThrough(store, "goal.create");
  const composed = createDaemonCommandPorts({
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
    deps: Object.freeze({
      authenticator, decisions: composed.decisions, registry: composed.registry,
    }),
    registry: composed.registry,
  };
}

function request(
  commandId: string, commandKind: string, payload: Readonly<Record<string, unknown>>,
  credential: string,
): Parameters<typeof handleCommandRequest>[1] {
  return {
    body: encoder.encode(JSON.stringify({
      commandId, commandKind, correlationId: `corr-${commandId}`, expectedVersion: 0, payload,
      requestDigest: "b".repeat(64), schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential, targetAggregateId: `fence:${commandKind}`,
    })),
    credential,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

/** An AGENT session holding EXACTLY the capability the registry entry demands, so the capability
 *  layer is satisfied and whatever refuses next is the fence under test. */
function agentSession(
  deps: CommandAdapterDeps, sessionId: string, capabilities: readonly string[],
): string {
  const secret = `secret-${sessionId}`;
  const opened = handleCommandRequest(deps, request(`cmd-open-${sessionId}`, "session.open", {
    capabilities: [...capabilities],
    credentialSha256: createHash("sha256").update(secret, "utf8").digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z",
    sessionId,
  }, CREDENTIAL), "HTTP_LISTENER");
  expect(opened).toMatchObject({ outcome: "ACCEPTED" });
  return secret;
}

const band = (kinds: Iterable<string>): readonly string[] =>
  [...kinds].filter((kind) => BAND.test(kind)).sort();

/** The three axes for one kind, read from the three production surfaces. */
function axesOf(kind: string): Record<string, boolean | string> {
  const advertisedOverMcp = new Set(wiredMcpToolKinds());
  return {
    humanOnlyStep: HUMAN_ONLY_STEPS.has(kind),
    kind,
    mcpExcluded: !advertisedOverMcp.has(kind),
    operatorPrincipal: OPERATOR_PRINCIPAL_KINDS.has(kind as never),
  };
}

describe("every band gate kind is fenced on all three axes, or on none of them", () => {
  it("enumerates the band from the dispatch seam and finds cases", () => {
    const kinds = band(ports().registry.keys());
    expect(kinds.length).toBeGreaterThan(0);
    // Every floor gate is SERVED. A gate that vanished from the registry would otherwise drop
    // out of every sweep below and take its own coverage with it.
    for (const gate of HUMAN_GATE_FLOOR) expect(kinds).toContain(gate);
    expect(kinds).toContain(SEAT_KIND);
  });

  it("never leaves a kind fenced on two axes out of three", () => {
    for (const kind of band(ports().registry.keys())) {
      const axes = axesOf(kind);
      const fenced = [axes["humanOnlyStep"], axes["mcpExcluded"], axes["operatorPrincipal"]]
        .filter((value) => value === true).length;
      // Reported as the whole axis record, so a failure names WHICH axis disagreed rather than
      // only that one did.
      expect({ ...axes, fenced }).toEqual({ ...axes, fenced: fenced === 0 ? 0 : 3 });
    }
  });

  it("fences every shipped human gate on all three axes", () => {
    for (const kind of HUMAN_GATE_FLOOR) {
      expect(axesOf(kind))
        .toEqual({ humanOnlyStep: true, kind, mcpExcluded: true, operatorPrincipal: true });
    }
  });

  it("leaves the design seat kind staffable on all three axes", () => {
    expect(axesOf(SEAT_KIND)).toEqual({
      humanOnlyStep: false, kind: SEAT_KIND, mcpExcluded: false, operatorPrincipal: false,
    });
  });
});

describe("an agent-authenticated dispatch of a human gate is refused by name", () => {
  it("refuses every shipped human gate with its code AND the layer that answered", async () => {
    const { deps, registry } = ports();
    const seen: string[] = [];
    for (const kind of HUMAN_GATE_FLOOR) {
      const entry = registry.get(kind as Parameters<typeof registry.get>[0]);
      if (entry === undefined) throw new Error(`${kind} is not served by the registry`);
      // The entry's OWN demanded capability, so AUTHORIZE passes and the OPERATOR fence is the
      // layer that answers. A weaker session would refuse CAPABILITY_DENIED @ AUTHORIZE and this
      // arm would be green while the human fence was gone.
      const secret = agentSession(deps, `sess-${kind.replace(".", "-")}`,
        [entry.requiredCapability]);
      const payload = kind === "release.decide"
        ? { base: "main", decision: "APPROVE", goalId: "goal-1", sha: "c".repeat(40) }
        : kind === "preview.decide"
          ? { decision: "APPROVE", previewRef: "preview-fence" }
          : { goalId: "goal-1" };
      const call = request(`cmd-agent-${kind.replace(".", "-")}`, kind, payload, secret);
      const answer = entry.asyncHandler === undefined
        ? handleCommandRequest(deps, call, "HTTP_LISTENER")
        : await handleAsyncCommandRequest(deps, call, "HTTP_LISTENER");
      expect({ kind, refusal: (answer as { refusal?: unknown }).refusal })
        .toMatchObject({ kind, refusal: OPERATOR_FENCE });
      seen.push(kind);
    }
    // The sweep is proven to have run every case rather than short-circuiting on the first.
    expect(seen).toEqual([...HUMAN_GATE_FLOOR]);
  });

  it("does NOT refuse the design seat kind on the operator fence", async () => {
    const { deps, registry } = ports();
    const entry = registry.get(SEAT_KIND);
    if (entry === undefined) throw new Error(`${SEAT_KIND} is not served by the registry`);
    const secret = agentSession(deps, "sess-design-seat", [entry.requiredCapability]);
    const answer = handleCommandRequest(deps, request(
      "cmd-agent-design-submit", SEAT_KIND,
      { contractRef: {}, goalRef: "goal-1", revision: {} }, secret,
    ), "HTTP_LISTENER");
    // The positive control for the arm above: this kind reaches its OWN slice and refuses on the
    // design vocabulary, never on the human fence. Add `design.submit` to OPERATOR_PRINCIPAL_KINDS
    // and this reds -- which is what stops a "consistency" edit unstaffing the design step.
    expect((answer as { refusal?: { code?: unknown } }).refusal?.code)
      .not.toBe(OPERATOR_FENCE.code);
  });
});
