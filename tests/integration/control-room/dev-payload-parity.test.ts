import { expect, it } from "vitest";

import { journeyAuthority } from "../../../apps/daemon/src/planning/journey-authority-bodies.js";
import { DEFAULT_GOAL_SUBJECT, DEFAULT_RUN_SUBJECT } from "../../../apps/daemon/src/http/affordance-read.js";
import { DEV_PAYLOADS, payloadFor } from "../../../apps/control-room/src/live/live-dispatch.js";

/**
 * The control room cannot import the daemon, so its plan.propose dev payload SPELLS the
 * planning-authority bodies the daemon's journey producer mints for the live subjects. The
 * daemon re-encodes those bodies and re-derives their digests at plan.propose, so a drifted
 * spelling does not seal differently - it stops the board's chain at plan.propose with a codec
 * code. This test is the only place the two sides meet: the board's bytes against the producer.
 *
 * task-c96ef2d1 widened the join. The producer now also mints the GRAPH BODY and RECOMPUTES its
 * full graphContentHash, and the propose terminal carries the canonical bytes as a sibling of
 * `authority`. A UI literal that drifted from those bytes is not merely a wrong graph - it is
 * REFUSED at the ingress (PLANNING_GRAPH_CONTENT_HASH_MISMATCH or _MALFORMED), so this arm pins
 * the bytes, the recomputed hash, and every place that hash has to reappear downstream.
 *
 * WHY THE CODEC IS NOT IMPORTED HERE. The root workspace declares @moe/contracts, @moe/daemon,
 * @moe/import, @moe/jetbrains-adapter, @moe/mcp, @moe/runner and @moe/store - NOT @moe/scheduler,
 * and this repo has no tsconfig `paths` and no project references, so a deep relative import into
 * packages/scheduler fails TS6059. The producer already ran `encodeGraphContent`, so its result IS
 * the codec's verdict; the decode/re-encode round trip is asserted where the dependency edge
 * really exists, in apps/daemon/src/planning/planning-authority-persistence.test.ts.
 */

const CONTENT_MEMBER = "graphContentBytesBase64";

function chainOf(version: number): readonly Record<string, unknown>[] {
  const payload = payloadFor("plan.propose", DEFAULT_RUN_SUBJECT, version);
  if (payload === null) throw new Error("no plan.propose payload");
  return payload["commands"] as readonly Record<string, unknown>[];
}

/** The one producer result every assertion below is graded against. */
function producerResult(): ReturnType<typeof journeyAuthority> {
  return journeyAuthority({
    authorRef: "operator-local",
    criterionIds: [`${DEFAULT_GOAL_SUBJECT}-criterion`],
    graphRevisionRef: "graph-revision-1",
    idPrefix: DEFAULT_RUN_SUBJECT,
    nodeIds: ["node-code-1"],
    stepDescription: "Land the live board's demo node.",
  });
}

const proposeTerminal = (): Record<string, unknown> => {
  const planning = chainOf(0);
  const terminal = planning[planning.length - 1];
  if (terminal === undefined) throw new Error("the board's planning chain is empty");
  return terminal as Record<string, unknown>;
};

const finalizeTerminal = (): Record<string, unknown> => {
  const terminal = chainOf(1)[0];
  if (terminal === undefined) throw new Error("the board's finalize chain is empty");
  return terminal as Record<string, unknown>;
};

it("the board's sealed authority is byte-identical to the daemon producer's", () => {
  const sealed = producerResult();
  const propose = proposeTerminal();
  expect(propose["kind"]).toBe("plan.propose");
  // Structural equality: the daemon canonicalises before digesting, so key order is not data.
  expect(propose["authority"]).toEqual(sealed.authority);
  expect(propose["submissionHash"]).toBe(sealed.submissionHash);

  const finalize = finalizeTerminal();
  expect((finalize["revision"] as Record<string, unknown>)["planHash"]).toBe(sealed.submissionHash);
  const approval = DEV_PAYLOADS["approval.decide"] as Record<string, unknown>;
  expect((approval["record"] as Record<string, unknown>)["exactRevisionHash"]).toBe(sealed.submissionHash);
  expect(approval["runId"]).toBe(DEFAULT_RUN_SUBJECT);
});

it("the board's PROPOSE terminal carries the producer's canonical graph bytes", () => {
  const sealed = producerResult();
  const propose = proposeTerminal();

  // Typed BEFORE compared: two `undefined`s are equal, so an unasserted shape would let this
  // whole arm pass against a board payload that carries no body at all.
  expect(typeof sealed.graphContentBytesBase64).toBe("string");
  expect(sealed.graphContentBytesBase64.length).toBeGreaterThan(0);
  expect(typeof propose[CONTENT_MEMBER]).toBe("string");

  expect(propose[CONTENT_MEMBER]).toBe(sealed.graphContentBytesBase64);
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
  expect(Array.from(decoded))
    .toEqual(Array.from(Uint8Array.from(Buffer.from(producerResult().graphContentBytesBase64, "base64"))));
});

it("every place the board restates that graph hash names the recomputed one", () => {
  const sealed = producerResult();
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
  expect(typeof sealed.graphContentHash).toBe("string");
  for (const value of stated) expect(value).toBe(sealed.graphContentHash);
  // The retired placeholder, named so a half-migrated sender cannot pass by keeping one copy.
  expect(stated).not.toContain("c0ffee".padEnd(64, "0"));
});

it("the board approval names only server-verifiable human and graph authority", () => {
  const approval = DEV_PAYLOADS["approval.decide"] as Record<string, unknown>;
  const activation = approval["activation"] as Record<string, unknown>;
  const record = approval["record"] as Record<string, unknown>;

  expect(activation).not.toHaveProperty("budgetHash");
  expect(record["actor"]).toBe("operator-local");
  expect(record["approvedNodeScope"]).toEqual(["node-code-1"]);
});
