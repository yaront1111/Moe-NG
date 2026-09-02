import { expect, it } from "vitest";

import { journeyAuthority } from "../../../apps/daemon/src/planning/journey-authority-bodies.js";
import {
  resolvePlanningAuthorities,
} from "../../../apps/daemon/src/http/affordance-planning-authorities.js";
import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT } from "../../../apps/daemon/src/http/affordance-read.js";
import { frameOfSurface } from "../../../apps/control-room/src/live/live-board-feed.js";
import {
  planningPayloadFor,
} from "../../../apps/control-room/src/live/live-planning-authorities.js";
import { DEV_PAYLOADS, dispatchAffordance } from "../../../apps/control-room/src/live/live-dispatch.js";

/**
 * THE ONE PLACE THE TWO SIDES MEET, over material only the daemon can author.
 *
 * The premise this file used to encode is retired. It asserted that the board MINTED a sealed
 * authority and that the mint was byte-identical to the producer's - a parity check between two
 * implementations of one canonicalisation. task-d3bfc33e removed the board's half: the daemon
 * now authors per-run material on the affordance surface, and the browser validates a bounded
 * transport shape, checks two bindings and assembles the caller half around bytes it never
 * touches. `payloadFor` answers null for `plan.propose` and `approval.decide` unconditionally,
 * so no fixture routed through it can be green again, and re-adding a board-side mint to make
 * one is exactly what rail 2 forbids.
 *
 * WHAT REPLACES IT IS A JOIN, NOT A WEAKENING. Every value below is obtained from the REAL
 * producer, `resolvePlanningAuthorities`, and carried over the REAL reader, `frameOfSurface`,
 * before the board authors anything:
 *
 *     resolvePlanningAuthorities  ->  surface response  ->  frameOfSurface  ->  planningPayloadFor
 *          (daemon side)                 (the wire)          (browser side)        (under test)
 *
 * The strictness is unchanged and in two places stronger: the propose terminal still carries the
 * producer's canonical bytes, the base64 spelling is still the exact one the ingress admits, the
 * graph hash still has to reappear in all three downstream restatements, and two SIBLING runs are
 * now sealed so that authoring B's card off A's material is a caught error rather than an
 * indistinguishable one. What changed is the SOURCE of the values, not what is demanded of them.
 *
 * WHY THE FIXTURE CANNOT SHORTCUT THE READER. Material is held in a module-private WeakMap keyed
 * by the exact frozen offer records `frameOfSurface` mints, so a structurally identical literal
 * is a different object and carries nothing. There is no way to hand the board authority except
 * to put it on the wire and let the production reader bind it, which is the property that makes
 * this an integration test rather than a fixture with extra steps.
 */

const PRINCIPAL_ID = "operator-local";
const NODE_REF = "node-code-1";
const CONTENT_MEMBER = "graphContentBytesBase64";

/** The second offered run. Sibling to the default one, and bound to its OWN durable goal. */
const SIBLING_RUN = "run-sibling-b";
const SIBLING_GOAL = "goal-sibling-b";

/** The retired placeholder, kept by name so a half-migrated sender cannot pass by keeping one copy. */
const RETIRED_GRAPH_HASH = "c0ffee".padEnd(64, "0");

interface Offer {
  readonly commandId: string;
  readonly commandKind: string;
  readonly expectedVersion: number;
  readonly targetAggregateId: string;
}

const offerFor = (runId: string, commandKind: string): Offer => Object.freeze({
  commandId: `${runId}-${commandKind}`,
  commandKind,
  expectedVersion: 0,
  targetAggregateId: runId,
});

/**
 * Both runs, both authority-bearing kinds. A is FIRST in the map by construction (the producer
 * sorts its eligible runs), which is what makes the sibling arm below able to catch a consumer
 * that reads the map's head instead of the offer's own entry.
 */
const OFFERS: readonly Offer[] = Object.freeze([
  offerFor(DEFAULT_RUN_SUBJECT, "plan.propose"),
  offerFor(DEFAULT_RUN_SUBJECT, "approval.decide"),
  offerFor(SIBLING_RUN, "plan.propose"),
  offerFor(SIBLING_RUN, "approval.decide"),
]);

const GOAL_REFS: Readonly<Record<string, string>> = Object.freeze({
  [DEFAULT_RUN_SUBJECT]: DEFAULT_GOAL_SUBJECT,
  [SIBLING_RUN]: SIBLING_GOAL,
});

/** The daemon's own map, sealed by the daemon's own producer. No literal is restated here. */
function producedMaterial(): Record<string, unknown> {
  return resolvePlanningAuthorities({
    nodes: [{ nodeRef: NODE_REF }],
    offers: OFFERS as unknown as Parameters<typeof resolvePlanningAuthorities>[0]["offers"],
    planningGoalRefs: GOAL_REFS,
    principalId: PRINCIPAL_ID,
  }) as unknown as Record<string, unknown>;
}

/** The surface body the daemon would answer, carrying that map verbatim. */
function surface(): Record<string, unknown> {
  return {
    nextAllowedCommands: OFFERS.map((offer) => ({ ...offer })),
    outcome: "SURFACE",
    planningAuthorityByRun: producedMaterial(),
    planningGoalRefs: { ...GOAL_REFS },
    steps: [],
  };
}

/**
 * The offer record the PRODUCTION reader minted - the only object the board will author against.
 * Read through `frameOfSurface` rather than reused from OFFERS: identity is the binding.
 */
function boundOffer(runId: string, commandKind: string): Record<string, unknown> {
  const frame = frameOfSurface(surface());
  expect(frame.connection).toBe("CONNECTED");
  const offer = frame.offers.find(
    (candidate) => candidate["targetAggregateId"] === runId
      && candidate["commandKind"] === commandKind,
  );
  if (offer === undefined) throw new Error(`the reader bound no ${commandKind} offer for ${runId}`);
  return offer;
}

/** One run's entry as the daemon sealed it. */
function entryFor(runId: string): Record<string, unknown> {
  const entry = producedMaterial()[runId];
  if (entry === undefined || entry === null) {
    throw new Error(`the producer sealed no material for ${runId}`);
  }
  return entry as Record<string, unknown>;
}

function chainOf(runId: string, goalRef: string, version: number): readonly Record<string, unknown>[] {
  const payload = planningPayloadFor(
    "plan.propose", boundOffer(runId, "plan.propose"), version, goalRef,
  );
  if (payload === null) throw new Error(`no plan.propose payload for ${runId}`);
  return payload["commands"] as readonly Record<string, unknown>[];
}

/** The approval the board would send for one offered run, built by production. */
function approvalFor(runId: string, goalRef: string): Record<string, unknown> {
  const payload = planningPayloadFor(
    "approval.decide", boundOffer(runId, "approval.decide"), 4, goalRef,
  );
  if (payload === null) throw new Error(`no approval.decide payload for ${runId}`);
  return payload as Record<string, unknown>;
}

const proposeTerminal = (
  runId = DEFAULT_RUN_SUBJECT, goalRef = DEFAULT_GOAL_SUBJECT,
): Record<string, unknown> => {
  const planning = chainOf(runId, goalRef, 0);
  const terminal = planning[planning.length - 1];
  if (terminal === undefined) throw new Error("the board's planning chain is empty");
  return terminal as Record<string, unknown>;
};

const finalizeTerminal = (
  runId = DEFAULT_RUN_SUBJECT, goalRef = DEFAULT_GOAL_SUBJECT,
): Record<string, unknown> => {
  const terminal = chainOf(runId, goalRef, 1)[0];
  if (terminal === undefined) throw new Error("the board's finalize chain is empty");
  return terminal as Record<string, unknown>;
};

it("the map carries the producer's seal verbatim, and the board carries the map's", () => {
  // SIDE ONE, the raw producer, invoked with the arguments `sealFor` states it uses. This pins
  // that the daemon's map CARRIES `journeyAuthority`'s return rather than rebuilding it - the
  // property the retired arm was really defending, now asserted where it is actually decidable.
  const sealed = journeyAuthority({
    authorRef: PRINCIPAL_ID,
    criterionIds: [`${DEFAULT_GOAL_SUBJECT}-criterion`],
    graphRevisionRef: `${DEFAULT_RUN_SUBJECT}-graph-revision`,
    idPrefix: DEFAULT_RUN_SUBJECT,
    nodeIds: [NODE_REF],
    stepDescription: `Plan ${DEFAULT_GOAL_SUBJECT} on ${DEFAULT_RUN_SUBJECT}.`,
  });
  const entry = entryFor(DEFAULT_RUN_SUBJECT);
  expect(entry["authority"]).toEqual(sealed.authority);
  expect(entry["submissionHash"]).toBe(sealed.submissionHash);
  expect(entry["graphContentHash"]).toBe(sealed.graphContentHash);

  // SIDE TWO, the board, reached only through the wire and the production reader.
  const propose = proposeTerminal();
  expect(propose["kind"]).toBe("plan.propose");
  // Structural equality: the daemon canonicalises before digesting, so key order is not data.
  expect(propose["authority"]).toEqual(entry["authority"]);
  expect(propose["submissionHash"]).toBe(entry["submissionHash"]);

  const finalize = finalizeTerminal();
  expect((finalize["revision"] as Record<string, unknown>)["planHash"]).toBe(entry["submissionHash"]);
  // Read through the production selector, not the identity-free base it builds from:
  // the run an approval names is now the OFFER's target, so the base carries none.
  const approval = approvalFor(DEFAULT_RUN_SUBJECT, DEFAULT_GOAL_SUBJECT);
  expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"])
    .toBe(entry["submissionHash"]);
  expect(approval["runId"]).toBe(DEFAULT_RUN_SUBJECT);
  expect(DEV_PAYLOADS["approval.decide"]).not.toHaveProperty("runId");
});

it("the board's PROPOSE terminal carries the producer's canonical graph bytes", () => {
  const entry = entryFor(DEFAULT_RUN_SUBJECT);
  const propose = proposeTerminal();

  // Typed BEFORE compared: two `undefined`s are equal, so an unasserted shape would let this
  // whole arm pass against a board payload that carries no body at all.
  expect(typeof entry[CONTENT_MEMBER]).toBe("string");
  expect(String(entry[CONTENT_MEMBER]).length).toBeGreaterThan(0);
  expect(typeof propose[CONTENT_MEMBER]).toBe("string");

  expect(propose[CONTENT_MEMBER]).toBe(entry[CONTENT_MEMBER]);
  // The bytes ride the PROPOSE terminal and NOWHERE else: the daemon's finalize ingress lists
  // this key in FORBIDDEN_BODY_KEYS and refuses the whole request outright if it appears there.
  expect(finalizeTerminal()).not.toHaveProperty(CONTENT_MEMBER);
});

it("the board's spelling of those bytes is the CANONICAL base64 the ingress admits", () => {
  const propose = proposeTerminal();

  // Typed first: without this the arm reds on the base64 round trip of the STRING "undefined",
  // which is a true failure for a misleading reason.
  expect(typeof propose[CONTENT_MEMBER]).toBe("string");
  const spelled = String(propose[CONTENT_MEMBER]);
  const decoded = Uint8Array.from(Buffer.from(spelled, "base64"));

  // `Buffer.from(s, "base64")` never throws - whitespace, the url-safe alphabet and missing
  // padding all decode best-effort - so the ingress re-encodes and compares, and a board literal
  // spelled any other way is refused PLANNING_GRAPH_CONTENT_MALFORMED. Same check, same reason.
  expect(decoded.length).toBeGreaterThan(0);
  expect(Buffer.from(decoded).toString("base64")).toBe(spelled);
  const graphJson = Buffer.from(decoded).toString("utf8");
  expect(graphJson).toContain('"admissionGatePolicy":"HUMAN_APPROVAL"');
  expect(graphJson).not.toContain('"admissionGatePolicy":"POLICY_ALLOWANCE"');
  expect(Array.from(decoded)).toEqual(Array.from(Uint8Array.from(
    Buffer.from(String(entryFor(DEFAULT_RUN_SUBJECT)[CONTENT_MEMBER]), "base64"),
  )));
});

it("every place the board restates that graph hash names the producer's", () => {
  const entry = entryFor(DEFAULT_RUN_SUBJECT);
  const authority = proposeTerminal()["authority"] as Record<string, unknown>;
  const revision = authority["planRevision"] as Record<string, unknown>;
  const contract = authority["acceptanceContract"] as Record<string, unknown>;
  const finalize = finalizeTerminal();

  const stated = [
    (revision["graphBinding"] as Record<string, unknown>)["graphContentHash"],
    (contract["applicability"] as Record<string, unknown>)["graphContentHash"],
    (finalize["revision"] as Record<string, unknown>)["graphContentHash"],
  ];

  // A swept set that produced zero entries would pass vacuously, so its size is pinned first.
  expect(stated).toHaveLength(3);
  expect(typeof entry["graphContentHash"]).toBe("string");
  for (const value of stated) expect(value).toBe(entry["graphContentHash"]);
  expect(stated).not.toContain(RETIRED_GRAPH_HASH);
});

it("the board approval names only server-verifiable human and graph authority", () => {
  const approval = approvalFor(DEFAULT_RUN_SUBJECT, DEFAULT_GOAL_SUBJECT);
  const activation = approval["activation"] as Record<string, unknown>;
  const record = approval["record"] as Record<string, unknown>;

  expect(activation).not.toHaveProperty("budgetHash");
  expect(record["actor"]).toBe(PRINCIPAL_ID);
  expect(record["approvedNodeScope"]).toEqual([NODE_REF]);
  // The activation's graph hash is the producer's for THIS run, never a board-side derivation.
  expect(activation["graphHash"]).toBe(entryFor(DEFAULT_RUN_SUBJECT)["graphContentHash"]);
});

it("the payload for an offered run carries THAT run's material, never the map's first entry", () => {
  const first = entryFor(DEFAULT_RUN_SUBJECT);
  const sibling = entryFor(SIBLING_RUN);

  // THE PREMISE, AND THE MEASURED LIMIT ON IT. Two entries, A first by the producer's own sort.
  expect(Object.keys(producedMaterial()).length).toBe(2);
  expect(Object.keys(producedMaterial())[0]).toBe(DEFAULT_RUN_SUBJECT);

  // The four members that DO discriminate. Any one of them is enough to catch a consumer that
  // authored B's card off A's entry, and they are asserted individually rather than as a bundle
  // so a future producer change that collapses one of them reds here instead of silently
  // narrowing what this arm can catch.
  expect(sibling["runId"]).not.toBe(first["runId"]);
  expect(sibling["goalRef"]).not.toBe(first["goalRef"]);
  expect(sibling["graphRevisionRef"]).not.toBe(first["graphRevisionRef"]);
  expect(sibling["submissionHash"]).not.toBe(first["submissionHash"]);

  // THE TWO THAT DO NOT, measured rather than assumed - and this is the reason the arm cannot be
  // written over the graph bytes. `sealFor` builds the graph from the NODE ROSTER, which both
  // runs share (the surface seals material only for a single-node roster), so the content bytes
  // and their hash are IDENTICAL across siblings while the plan identity is not. A consumer that
  // read the map's first entry would therefore still produce the right bytes and the right graph
  // hash, and an arm that pinned only those would pass on the wrong entry.
  expect(sibling[CONTENT_MEMBER]).toBe(first[CONTENT_MEMBER]);
  expect(sibling["graphContentHash"]).toBe(first["graphContentHash"]);

  // B's card, authored off B's offer. Every operand must be B's.
  const propose = proposeTerminal(SIBLING_RUN, SIBLING_GOAL);
  expect(propose["submissionHash"]).toBe(sibling["submissionHash"]);
  expect(propose["authority"]).toEqual(sibling["authority"]);
  expect(chainOf(SIBLING_RUN, SIBLING_GOAL, 0)[0]?.["runId"]).toBe(SIBLING_RUN);
  expect(chainOf(SIBLING_RUN, SIBLING_GOAL, 0)[0]?.["goalRef"]).toBe(SIBLING_GOAL);

  const approval = approvalFor(SIBLING_RUN, SIBLING_GOAL);
  expect(approval["runId"]).toBe(SIBLING_RUN);
  expect(approval["graphRevisionRef"]).toBe(sibling["graphRevisionRef"]);
  expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"])
    .toBe(sibling["submissionHash"]);

  // Stated as an exclusion too, on the members that discriminate: a consumer reading the map's
  // head would produce A's operands here, and each equality above is only load-bearing because
  // the corresponding value differs between the siblings.
  expect(propose["submissionHash"]).not.toBe(first["submissionHash"]);
  expect(propose["authority"]).not.toEqual(first["authority"]);
  expect(approval["graphRevisionRef"]).not.toBe(first["graphRevisionRef"]);
  expect(approval["runId"]).not.toBe(first["runId"]);
});

it("an offer the daemon stated no material for refuses at its own code and layer, untransported", () => {
  // A run the surface offers but seals NO material for: `planningGoalRefs` binds it, so the
  // goal-binding gate passes and the refusal below can only come from the authority gate.
  const unsealed = "run-unsealed-c";
  const offers = [...OFFERS.map((offer) => ({ ...offer })), {
    commandId: `${unsealed}-plan.propose`,
    commandKind: "plan.propose",
    expectedVersion: 0,
    targetAggregateId: unsealed,
  }];
  const goalRefs = { ...GOAL_REFS, [unsealed]: "goal-unsealed-c" };
  const frame = frameOfSurface({
    nextAllowedCommands: offers,
    outcome: "SURFACE",
    // The producer's own map, which names A and B and not the third run.
    planningAuthorityByRun: producedMaterial(),
    planningGoalRefs: goalRefs,
    steps: [],
  });
  expect(frame.connection).toBe("CONNECTED");
  const offer = frame.offers.find((candidate) => candidate["targetAggregateId"] === unsealed);
  if (offer === undefined) throw new Error("the reader bound no offer for the unsealed run");

  // The board authors nothing for it, and says so with the code that sends an operator to the
  // right repair - distinct from the goal-binding refusal, which is why the goal IS bound here.
  expect(planningPayloadFor("plan.propose", offer, 0, "goal-unsealed-c")).toBeNull();

  const calls: string[] = [];
  const transport = {
    sendCommand: async () => {
      calls.push("sendCommand");
      return { ok: true } as never;
    },
  };
  return dispatchAffordance({
    affordance: offer,
    aggregateId: unsealed,
    client: {} as never,
    kind: "plan.propose",
    planningGoalRefs: goalRefs,
    readBudgetCommitment: async () => {
      calls.push("readBudgetCommitment");
      return { code: "UNREACHED", layer: "TEST", status: "REFUSED" } as never;
    },
    sessionCredential: "session-test",
    transport: transport as never,
    version: 0,
  }).then((report) => {
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("BUILD_REFUSED");
    // The exact code AND the refusing layer, not merely "it refused".
    expect(report.detail).toBe("PLANNING_AUTHORITY_BINDING_ABSENT @ CONTROL_ROOM_LIVE_DISPATCH");
    // It refuses BEFORE the commitment read and the transport, so an unauthorable card costs
    // the daemon nothing and never reaches a seam that could answer for a body never assembled.
    expect(calls).toEqual([]);
  });
});
