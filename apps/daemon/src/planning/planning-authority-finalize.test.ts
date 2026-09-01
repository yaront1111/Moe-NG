/**
 * The daemon finalize seam: `planning.finalize_submission` folded from DURABLE state, and
 * b42db644's planning-authority envelope composed from the durable BODIES record.
 *
 * Before this row `PLANNING_HANDLERS` was exactly {approval.decide, plan.propose} and
 * `proposePlan` required the last chain element to be `plan.propose`, so no daemon path ever
 * reached lifecycle PLAN_REVIEW and the envelope's `readSubmission` gate had no producer
 * (comment-4f54a956). Everything below therefore runs through the REAL production edge — a real
 * `SqliteEventStore`, the real `plan.propose` handler — because the whole claim of the row is
 * that a REAL seam now folds it.
 *
 * The bodies are minted by core's own `createPlanRevision` / `createAcceptanceContract` and read
 * back through the certified envelope codec. Nothing here restates a cross-binding rule: the
 * codec owns all ten, and each hostile arm asserts the codec's OWN code and layer.
 */
import { createHash } from "node:crypto";

import {
  createAcceptanceContract, createPlanRevision, derivePolicySliceDigest, encodePlanRevision,
} from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { legacyProposedStore } from "../bootstrap/bootstrap-journey-fixtures.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  hex64,
  openStore,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { decodeGraphContent } from "@moe/scheduler";
import { readPolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { putGraphBody } from "./graph-body-record.js";
import { RUN_POLICY_ACTION, runPolicyAggregateId } from "./run-policy-record.js";
import { journeyAuthority } from "./journey-authority-bodies.js";
import { decodePlanningAuthorityEnvelopeBytes } from "./planning-authority-envelope.js";
import { PLANNING_AUTHORITY_FINALIZE_CODES } from "./planning-authority-finalize-ingress.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";

type Json = Record<string, unknown>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const AUTHORITY_AGGREGATE = planningAuthorityAggregateId(RUN_ID);
const BODIES_EVENT = "PlanningAuthorityBodiesSealed";
const ENVELOPE_EVENT = "PlanningAuthorityEnvelopeSealed";
const FINALIZE_EVENT = "PlanningSubmissionFinalized";
const ENVELOPE_LAYER = "PLANNING_AUTHORITY_ENVELOPE";
const GRAPH_REVISION_REF = "graph-revision-authority";
const CRITERION_IDS = Object.freeze(["criterion-a", "criterion-b"]);
/**
 * MIGRATED, not re-pointed, by task-c96ef2d1 - the subject was never the placeholder.
 *
 * This suite's bodies are its OWN (`architect-finalize`, `revision-finalize`,
 * `contract-finalize`), because several arms assert on those ids and on core's refusal codes for
 * them. Only the GRAPH they bind to comes from the shipped producer, which is the one fact this
 * suite cannot mint for itself: `graphContentBytesBase64` is mandatory at propose, and the
 * ingress RECOMPUTES the hash from those bytes, so a body stating the retired placeholder is
 * refused PLANNING_GRAPH_CONTENT_HASH_MISMATCH before any finalize assertion is reached. Taking
 * the hash and the bytes from one `journeyAuthority` result is what keeps every negative world
 * below refusing for ITS OWN reason instead of for a missing graph.
 */
const JOURNEY_GRAPH = journeyAuthority({
  authorRef: "architect-finalize",
  criterionIds: [...CRITERION_IDS],
  graphRevisionRef: GRAPH_REVISION_REF,
  idPrefix: "finalize-graph",
  nodeIds: ["node-a"],
  stepDescription: "Land the finalize seam.",
});
const GRAPH_CONTENT_HASH = JOURNEY_GRAPH.graphContentHash;
const TRUTH = "DAEMON_VERIFIED";

/**
 * Records THIS suite's graph body, which its own `plan.propose` arms carry as a sibling member.
 *
 * The legacy world below replays the SHIPPED chain's propose, so it holds the shipped graph's
 * body and not this suite's — and since task-a888038d the finalize terminal evaluates the sealed
 * graph and refuses `RUN_POLICY_GRAPH_UNAVAILABLE` when it cannot read it. Seeding the body keeps
 * those arms about the one absence they were written for, the planning-AUTHORITY member.
 */
function seedSuiteGraphBody(store: SqliteEventStore): SqliteEventStore {
  const decoded = decodeGraphContent(
    Uint8Array.from(Buffer.from(JOURNEY_GRAPH.graphContentBytesBase64, "base64")),
  );
  if (!decoded.ok) throw new Error("the suite graph must decode");
  const put = putGraphBody(store, PROJECT_ID, decoded.value);
  if (!put.ok) throw new Error(`the suite graph body must store: ${put.code}`);
  return store;
}

afterEach(() => {
  closeStores();
});

function planRevision(): Json {
  const built = createPlanRevision({
    affectedCriterionIds: [...CRITERION_IDS],
    affectedNodeIds: ["node-a"],
    approvalState: "PENDING_APPROVAL",
    authorRef: "architect-finalize",
    graphBinding: { graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF },
    parentRevisionId: null,
    rejectionRef: null,
    revisionId: "revision-finalize",
    steps: [{ description: "Land the finalize seam.", kind: "ANALYSIS", stepId: "step-00001" }],
    verificationRecipeRefs: ["recipe-gate"],
  });
  if (!built.ok) throw new Error(`plan fixture refused: ${built.code}@${built.layer}`);
  return built.revision as unknown as Json;
}

function acceptanceContract(): Json {
  const built = createAcceptanceContract({
    applicability: {
      graphContentHash: GRAPH_CONTENT_HASH, graphRevisionRef: GRAPH_REVISION_REF,
      nodeIds: ["node-a"], nodeKind: "LEAF",
    },
    authorRef: "architect-finalize",
    contractId: "contract-finalize",
    obligations: CRITERION_IDS.map((criterionId) => ({
      criterionId,
      evidenceRequirements: [{
        evidenceRef: `evidence-${criterionId}`, kind: "VERIFICATION_RECEIPT",
        requirementId: `requirement-${criterionId}`,
      }],
      statement: `the run satisfies ${criterionId}`,
      verificationRecipeRefs: [`recipe-${criterionId}`],
    })),
  });
  if (!built.ok) throw new Error(`acceptance fixture refused: ${built.code}@${built.layer}`);
  return built.contract as unknown as Json;
}

const PLAN_HASH = String(planRevision()["planHash"]);

/** The chain the daemon folds today, with the LAST propose carrying the authority bodies. */
function authorityChain(): readonly Json[] {
  const chain = [...planningChain()] as Json[];
  const last = chain[chain.length - 1] as Json;
  chain[chain.length - 1] = {
    ...last,
    authority: { acceptanceContract: acceptanceContract(), planRevision: planRevision() },
    // A SIBLING of `authority` and mandatory since task-c96ef2d1. The bytes are the producer's,
    // so the hash the ingress recomputes IS the one both bodies above state.
    graphContentBytesBase64: JOURNEY_GRAPH.graphContentBytesBase64,
    submissionHash: PLAN_HASH,
  };
  return chain;
}

/** The runner-proven finalization boundary: one execution-bearing node and a four-hash seal. */
function finalizeCommand(overrides: Json = {}, seal: Json = {}): Json {
  return {
    commandId: "chain-finalize",
    expectedVersion: 4,
    kind: "planning.finalize_submission",
    revision: {
      dependencyHash: hex64("d1"), graphContentHash: GRAPH_CONTENT_HASH,
      graphRevisionRef: GRAPH_REVISION_REF, planHash: PLAN_HASH, qualityHash: hex64("dd"),
      ...seal,
    },
    witness: {
      attemptTerminalRef: "attempt-terminal-1", effectTerminalRef: "effect-terminal-1",
      nodeSummaries: [{ executionBearing: true, nodeKey: "node-a" }],
      providerSlotTerminalRef: "slot-terminal-1", resourcesTerminalRef: "resources-terminal-1",
      truthClass: TRUTH,
    },
    ...overrides,
  };
}

function submit(store: SqliteEventStore, payload: Json, commandId: string): ServiceOutcome {
  return send(store, envelope("plan.propose", 0, { runId: RUN_ID, ...payload }, commandId));
}

const propose = (store: SqliteEventStore, chain: readonly Json[]): ServiceOutcome =>
  submit(store, { commands: chain }, "cmd-plan.propose");

const finalize = (
  store: SqliteEventStore, seal: Json = {}, commandId = "cmd-finalize",
): ServiceOutcome => submit(store, { commands: [finalizeCommand({}, seal)] }, commandId);

function readyStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "plan.propose");
  return store;
}

/** A store whose run has durably proposed; with bodies the authority aggregate sits at 1. */
function proposedStore(chain: readonly Json[] = authorityChain()): SqliteEventStore {
  const store = readyStore();
  if (!propose(store, chain).ok) throw new Error("the proposal fixture was refused");
  return store;
}

function refusalOf(outcome: ServiceOutcome): { code: string; refusedBy: string } {
  if (outcome.ok) throw new Error("expected a refusal, received an accepted decision");
  return { code: outcome.code, refusedBy: outcome.refusedBy };
}

function resultOf(outcome: ServiceOutcome): Json {
  if (!outcome.ok) throw new Error(`expected an accepted decision, got ${outcome.code}`);
  return JSON.parse(decoder.decode(outcome.decision.resultBytes)) as Json;
}

function eventPayload(store: SqliteEventStore, aggregateId: string, eventType: string): Json {
  const matches = store.readEvents(aggregateId).filter((event) => event.eventType === eventType);
  expect(matches.length).toBe(1);
  const only = matches[0];
  if (only === undefined) throw new Error(`no ${eventType} on ${aggregateId}`);
  return JSON.parse(decoder.decode(only.payload)) as Json;
}

const bytesFrom = (base64: unknown): Uint8Array =>
  Uint8Array.from(Buffer.from(String(base64), "base64"));

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Residue {
  readonly authorityVersion: number;
  readonly decisions: number;
  readonly runVersion: number;
}

const residueOf = (store: SqliteEventStore): Residue => ({
  authorityVersion: store.getAggregateVersion(AUTHORITY_AGGREGATE),
  decisions: decisionCount(store),
  runVersion: store.getAggregateVersion(RUN_ID),
});

/**
 * THE RUN'S OWN RISK TIER (task-a888038d, DoD 2/3).
 *
 * Every arm below drives the PRODUCTION `planning.finalize_submission` command over a real store;
 * none reaches into the evaluator. The subject is what a FINALIZED RUN durably carries, so the
 * assertions read the durable row back through the STRICT reader rather than trusting the payload.
 */
describe("daemon finalize seam — the run's policy risk", () => {
  const RUN_POLICY_AGGREGATE = runPolicyAggregateId(RUN_ID);

  /**
   * Installs a NEWER evaluation slice that classifies a fact id this run does not state.
   *
   * The shipped bootstrap sequence already installs a table naming the run's four ids, so this is
   * the single degree of freedom between the accepting and refusing worlds below: same graph,
   * same command, same store shape, one extra install whose only difference is WHICH ids it names.
   * A slice classifying nothing at all would not do — an empty table digests to the already
   * installed empty slice's address and `policy.install` would refuse it one layer earlier, and
   * the arm would then be grading the install ingress instead of the evaluator.
   */
  function installUnrelatedPolicy(store: SqliteEventStore): void {
    const body = {
      autoApprovalOptIns: [],
      riskClassifications: [{ factId: "node.capability:unrelated", tier: "R3" }],
      rules: [],
    };
    const digest = derivePolicySliceDigest({ ...body, sliceRef: "pending-unrelated" });
    if (!digest.ok) throw new Error("the unrelated slice must digest");
    const version = versionOf(readDurableLedger(store, PROJECT_ID), `${PROJECT_ID}-policy`);
    const outcome = send(store, envelope(
      "policy.install", version, { slice: { ...body, sliceRef: digest.digest } },
      "cmd-install-unrelated",
    ));
    if (!outcome.ok) throw new Error(`the unrelated install refused: ${outcome.code}`);
  }

  /** The ONE run-policy event, with its count asserted rather than assumed. */
  function store0(store: SqliteEventStore) {
    const events = store.readEvents(RUN_POLICY_AGGREGATE);
    expect(events).toHaveLength(1);
    const only = events[0];
    if (only === undefined) throw new Error("the finalized run wrote no policy row");
    return only;
  }

  /** The durable run row, read through the same strict reader every policy consumer uses. */
  function readRunAuthority(store: SqliteEventStore) {
    // ONE row per finalized run, not one per node: the evaluation is over the whole sealed graph.
    const only = store0(store);
    expect(only.eventType).toBe("PolicyEvaluated");
    const payload = JSON.parse(decoder.decode(only.payload)) as JsonValue;
    return readPolicyEvaluationAuthority(payload, PROJECT_ID, Date.parse(only.committedAt));
  }

  it("carries a daemon-computed tier linked to the run, derived from the SEALED graph", () => {
    const store = seedSuiteGraphBody(proposedStore());
    expect(finalize(store).ok).toBe(true);

    const authority = readRunAuthority(store);
    if (!authority.ok) throw new Error(`the run row did not read: ${authority.code}`);
    expect(authority.runId).toBe(RUN_ID);
    // SERVER-DERIVED, not the payload's. `finalizeCommand()` states `graphRevisionRef`
    // "graph-revision-1" and never states a node revision ref at all, so the only place this
    // value can have come from is the sealed body the fold produced.
    expect(authority.graphNodeRevisionRefs).toStrictEqual([GRAPH_CONTENT_HASH]);
    expect(authority.riskTier).toBe("R2");
    expect(authority.action).toBe(RUN_POLICY_ACTION);
  });

  it("REFUSES the whole finalize when the installed policy cannot tier the run", () => {
    const store = seedSuiteGraphBody(proposedStore());
    // The newest installed evaluation slice classifies a fact id this run does not state. One
    // degree of freedom from the divergence arm below, which names the run's OWN ids.
    installUnrelatedPolicy(store);
    const before = residueOf(store);

    const outcome = finalize(store);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("an untierable run must not finalize");
    expect(outcome.code).toBe("RUN_POLICY_UNCLASSIFIABLE");
    expect(outcome.refusedBy).toBe("DAEMON_RUN_POLICY");

    // BOTH LEDGERS UNCHANGED. The seal and the evaluation are one decision, so a refusal from the
    // evaluation half leaves the submission un-finalized rather than sealed-and-untiered.
    expect(residueOf(store)).toStrictEqual(before);
    expect(store.readEvents(RUN_POLICY_AGGREGATE)).toStrictEqual([]);
    expect(store.readEvents(RUN_ID).filter((event) => event.eventType === FINALIZE_EVENT))
      .toStrictEqual([]);
  });

  it("DIVERGES on the classification alone: the same run, one table apart", () => {
    // Identical worlds but for which fact ids the newest installed table names. Nothing about the
    // run, the graph, the command or the store shape differs between the two.
    const refusing = seedSuiteGraphBody(proposedStore());
    installUnrelatedPolicy(refusing);
    expect(finalize(refusing).ok).toBe(false);

    const accepting = seedSuiteGraphBody(proposedStore());
    expect(finalize(accepting).ok).toBe(true);
    const authority = readRunAuthority(accepting);
    if (!authority.ok) throw new Error(`the run row did not read: ${authority.code}`);
    expect(authority.riskTier).toBe("R2");
  });

  it("takes no facts, tier, hint, scope or refs from the finalize payload", () => {
    // THE ROW IS THE WITNESS, not the outcome. The core reducer ignores unknown command members
    // rather than refusing them, so "it still finalized" would prove nothing; what proves the
    // evaluation is caller-proof is that the DURABLE row it wrote is byte-identical to the row a
    // clean run writes. `evaluateRunPolicy`'s input type has no member any of these could reach.
    const clean = seedSuiteGraphBody(proposedStore());
    expect(finalize(clean).ok).toBe(true);
    const baseline = decoder.decode(store0(clean).payload);

    for (const smuggled of [
      { facts: [{ factId: "node.capability:capability-implement", tier: "R3",
        truthClass: "DAEMON_VERIFIED" }] },
      { riskAssessment: { computedTier: "R0", effectiveTier: "R0" } },
      { callerRiskHint: "R0" },
      { scope: ["node-elsewhere"] },
      { graphNodeRevisionRefs: [hex64("ff")] },
      { policyRevisionRef: hex64("ee") },
    ]) {
      const named = Object.keys(smuggled)[0] ?? "none";
      const store = seedSuiteGraphBody(proposedStore());
      const outcome = submit(
        store, { commands: [{ ...finalizeCommand(), ...smuggled }] }, `cmd-finalize-${named}`,
      );
      if (!outcome.ok) throw new Error(`the smuggled ${named} refused: ${outcome.code}`);
      expect([named, decoder.decode(store0(store).payload)]).toStrictEqual([named, baseline]);
    }
  });

  it("refuses a finalize that presents the run's sealed hashes at the ingress", () => {
    // The ONE smuggled member the ingress does name, asserted with its own code and layer so the
    // arm above cannot be read as "nothing at this seam refuses anything".
    const store = seedSuiteGraphBody(proposedStore());
    const outcome = submit(store, {
      commands: [{ ...finalizeCommand(), sealedHashes: { graphContentHash: hex64("ff") } }],
    }, "cmd-finalize-sealed-hashes");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("the ingress admitted sealedHashes");
    expect([outcome.code, outcome.refusedBy])
      .toStrictEqual(["PLANNING_FINALIZE_BODIES_SUPPLIED", "DAEMON_INGRESS"]);
  });
});

describe("daemon finalize seam — the accepted control", () => {
  it("folds finalize from durable state and seals the envelope in ONE decision", () => {
    const store = proposedStore();
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(1);
    const before = decisionCount(store);
    const outcome = finalize(store);
    expect(outcome.ok).toBe(true);
    expect(decisionCount(store)).toBe(before + 1);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(2);
  });

  it("reaches lifecycle PLAN_REVIEW durably and emits PlanRevisionCreated", () => {
    const store = proposedStore();
    const result = resultOf(finalize(store));
    const state = result["state"] as Json;
    expect(state["lifecycle"]).toBe("PLAN_REVIEW");
    expect(state["graphRevisionRef"]).toBe(GRAPH_REVISION_REF);
    expect((state["sealedHashes"] as Json)["planHash"]).toBe(PLAN_HASH);
    const events = eventPayload(store, RUN_ID, FINALIZE_EVENT) as unknown as readonly Json[];
    expect(events.map((event) => event["kind"])).toEqual(["PlanRevisionCreated"]);
  });

  it("seals exactly one envelope event the certified codec decodes", () => {
    const store = proposedStore();
    expect(finalize(store).ok).toBe(true);
    const sealed = eventPayload(store, AUTHORITY_AGGREGATE, ENVELOPE_EVENT);
    const decoded = decodePlanningAuthorityEnvelopeBytes(bytesFrom(sealed["envelopeBytesBase64"]));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("the sealed envelope did not decode");
    expect(decoded.envelope.submission).toEqual({
      criteriaDigest: eventPayload(store, AUTHORITY_AGGREGATE, BODIES_EVENT)["criteriaDigest"],
      goalRef: GOAL_ID, graphRevisionRef: GRAPH_REVISION_REF, lifecycle: "PLAN_REVIEW",
      projectId: PROJECT_ID, runId: RUN_ID,
      sealedHashes: {
        dependencyHash: hex64("d1"), graphContentHash: GRAPH_CONTENT_HASH,
        planHash: PLAN_HASH, qualityHash: hex64("dd"),
      },
      submissionHash: PLAN_HASH,
    });
    expect(decoded.envelope.bindings).toEqual({
      goalRef: GOAL_ID, projectId: PROJECT_ID, revisionId: "revision-finalize", runId: RUN_ID,
    });
  });

  it("carries the DURABLE bodies bytes, not a re-encoding of caller input", () => {
    const store = proposedStore();
    expect(finalize(store).ok).toBe(true);
    const bodies = eventPayload(store, AUTHORITY_AGGREGATE, BODIES_EVENT);
    const sealed = eventPayload(store, AUTHORITY_AGGREGATE, ENVELOPE_EVENT);
    const decoded = decodePlanningAuthorityEnvelopeBytes(bytesFrom(sealed["envelopeBytesBase64"]));
    if (!decoded.ok) throw new Error("the sealed envelope did not decode");
    const reencoded = encodePlanRevision(decoded.envelope.planRevision);
    if (!reencoded.ok) throw new Error("the envelope's plan revision did not re-encode");
    expect(base64Of(reencoded.bytes)).toBe(bodies["planRevisionBytesBase64"]);
    expect(decoded.envelope.acceptanceContract.contractId).toBe(bodies["criteriaRef"]);
  });

  it("binds the decision result to the envelope aggregate and its digest", () => {
    const store = proposedStore();
    const result = resultOf(finalize(store));
    const sealed = eventPayload(store, AUTHORITY_AGGREGATE, ENVELOPE_EVENT);
    const bytes = bytesFrom(sealed["envelopeBytesBase64"]);
    expect({ authorityRef: result["authorityRef"], envelopeDigest: result["envelopeDigest"] })
      .toEqual({ authorityRef: AUTHORITY_AGGREGATE, envelopeDigest: sha256(bytes) });
    expect(sealed["envelopeDigest"]).toBe(sha256(bytes));
    expect(sealed["planHash"]).toBe(PLAN_HASH);
  });

  /** The envelope aggregate is a SECONDARY leg, so `readDurableLedger` cannot see it at all. */
  it("keeps the envelope invisible to the ledger and readable from the store", () => {
    const store = proposedStore();
    expect(finalize(store).ok).toBe(true);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.get(AUTHORITY_AGGREGATE))
      .toBeUndefined();
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(2);
  });
});

/**
 * THE AUTHORITY-ABSENT ARM, re-graded by task-16a6a2b1. Production can no longer PROPOSE without
 * an authority member (PLANNING_AUTHORITY_REQUIRED), so this seam's authority-absent world is now
 * reachable only as pre-flip durable history and is PLANTED rather than driven. The finalize
 * itself still runs through production — only its operand moved. Per the task-93e8aab3
 * retirement ruling: a guard production can no longer trigger is fine to keep; a test implying
 * production still reaches it is not.
 */
describe("daemon finalize seam — the authority-absent arm", () => {
  it("commits the fold exactly and seals no envelope", () => {
    const store = seedSuiteGraphBody(legacyProposedStore());
    const outcome = finalize(store);
    expect(outcome.ok).toBe(true);
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(0);
  });

  it("writes byte-stable finalize events and no envelope binding in the result", () => {
    const store = seedSuiteGraphBody(legacyProposedStore());
    const result = resultOf(finalize(store));
    expect(Object.keys(result)).not.toContain("authorityRef");
    expect(Object.keys(result)).not.toContain("envelopeDigest");
    // `planHash` is READ off the finalize command this suite sends rather than spelled: since
    // task-16a6a2b1 the operand is a PLANTED run carrying the shipped chain's submission, not the
    // legacy SUBMISSION_HASH literal. Every other field stays byte-pinned, which is what the arm
    // is for — a spelled hash here would pin the FIXTURE's identity instead of the seam's output.
    const planHash = (finalizeCommand()["revision"] as Json)["planHash"];
    expect(typeof planHash).toBe("string");
    expect(eventPayload(store, RUN_ID, FINALIZE_EVENT)).toEqual([{
      commandId: "chain-finalize", graphRevisionRef: GRAPH_REVISION_REF,
      hashes: {
        dependencyHash: hex64("d1"), graphContentHash: GRAPH_CONTENT_HASH,
        planHash, qualityHash: hex64("dd"),
      },
      kind: "PlanRevisionCreated", version: 5,
    }]);
  });
});

describe("daemon finalize seam — the daemon owns two ingress refusals", () => {
  const SMUGGLED_KEYS = Object.freeze([
    "acceptanceContract", "authority", "envelope", "graphContentBytesBase64", "planRevision",
    "sealedHashes",
  ]);
  const SMUGGLE_CASES = SMUGGLED_KEYS.flatMap((key) =>
    (["command", "payload"] as const).map((surface) => ({ key, surface })));

  it("generates one smuggling case per forbidden key on both surfaces", () => {
    expect(SMUGGLE_CASES.length).toBe(12);
    expect(PLANNING_AUTHORITY_FINALIZE_CODES).toEqual([
      "PLANNING_FINALIZE_BODIES_SUPPLIED", "PLANNING_FINALIZE_CHAIN_MIXED",
    ]);
  });

  it.each(SMUGGLE_CASES)("refuses a $surface-supplied $key before any write", (probe) => {
    const { key, surface } = probe;
    const store = proposedStore();
    const before = residueOf(store);
    const body = { acceptanceContract: acceptanceContract() } as Json;
    const outcome = surface === "payload"
      ? submit(store, { commands: [finalizeCommand()], [key]: body }, "cmd-smuggle")
      : submit(store, { commands: [finalizeCommand({ [key]: body })] }, "cmd-smuggle");
    expect(refusalOf(outcome))
      .toEqual({ code: "PLANNING_FINALIZE_BODIES_SUPPLIED", refusedBy: "DAEMON_INGRESS" });
    expect(residueOf(store)).toEqual(before);
  });

  /** Each business effect owes its own decision, so the two terminal classes are exclusive. */
  it.each([
    { chain: () => [...authorityChain(), finalizeCommand()], name: "propose then finalize" },
    { chain: () => [finalizeCommand(), ...authorityChain()], name: "finalize then propose" },
  ])("refuses a mixed chain that runs $name", ({ chain }) => {
    const store = proposedStore();
    const before = residueOf(store);
    expect(refusalOf(submit(store, { commands: chain() }, "cmd-mixed")))
      .toEqual({ code: "PLANNING_FINALIZE_CHAIN_MIXED", refusedBy: "DAEMON_INGRESS" });
    expect(residueOf(store)).toEqual(before);
  });

  it("still refuses a chain that ends in neither terminal with the ingress code", () => {
    const store = proposedStore();
    const tail = { commandId: "chain-approve", expectedVersion: 4, kind: "plan.approve" };
    expect(refusalOf(submit(store, { commands: [tail] }, "cmd-tail")))
      .toEqual({ code: "BOOTSTRAP_PAYLOAD_INVALID", refusedBy: "DAEMON_INGRESS" });
  });
});

describe("daemon finalize seam — the envelope cannot compose without the fold", () => {
  /** No propose, so `finalize` sees `submissionHash === null` and the CORE refuses the fold. */
  it("passes the core's own ILLEGAL_TRANSITION through for a run that never proposed", () => {
    const store = readyStore();
    const chain = [...planningChain()].slice(0, 3) as Json[];
    chain.push(finalizeCommand({ expectedVersion: 3 }));
    const outcome = submit(store, { commands: chain }, "cmd-unproposed");
    expect(refusalOf(outcome)).toEqual({ code: "ILLEGAL_TRANSITION", refusedBy: "CORE_REDUCER" });
    expect(store.readEvents(AUTHORITY_AGGREGATE)).toEqual([]);
    expect(store.getAggregateVersion(RUN_ID)).toBe(0);
  });

  it.each([
    {
      code: "PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH",
      seal: { graphContentHash: hex64("ba5e") },
    },
    { code: "PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", seal: { planHash: hex64("badbad") } },
    { code: "PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH", seal: { graphRevisionRef: "graph-x" } },
  ])("refuses with the codec's own $code and zero residue", ({ code, seal }) => {
    const store = proposedStore();
    const before = residueOf(store);
    expect(refusalOf(finalize(store, seal))).toEqual({ code, refusedBy: ENVELOPE_LAYER });
    expect(residueOf(store)).toEqual(before);
  });
});

describe("daemon finalize seam — the record is the only body source", () => {
  /**
   * A run that proposed WITHOUT authority still composes once a bodies record exists on its
   * authority aggregate. Nothing but a durable read can explain that, so this is the positive
   * control for "the bodies come from the record, never from the request".
   */
  it("composes from a planted durable record on an authority-less proposal", () => {
    const donor = eventPayload(proposedStore(), AUTHORITY_AGGREGATE, BODIES_EVENT);
    // PLANTED since task-16a6a2b1 — see the authority-absent describe above. The bodies record
    // this arm plants on top is unchanged; what moved is how its authority-less proposal is built.
    const store = seedSuiteGraphBody(legacyProposedStore());
    store.commit({
      aggregateId: AUTHORITY_AGGREGATE,
      commandBytes: encoder.encode("planted-bodies"),
      commandId: "planted-bodies",
      committedAt: "2026-08-08T00:00:00.000Z",
      events: [{
        eventId: `${RUN_ID}-${BODIES_EVENT}`, eventType: BODIES_EVENT,
        payload: encoder.encode(JSON.stringify(donor)),
      }],
      expectedVersion: 0,
    });
    expect(finalize(store).ok).toBe(true);
    const sealed = eventPayload(store, AUTHORITY_AGGREGATE, ENVELOPE_EVENT);
    expect(decodePlanningAuthorityEnvelopeBytes(bytesFrom(sealed["envelopeBytesBase64"])).ok)
      .toBe(true);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(2);
  });
});

describe("daemon finalize seam — the refusal arm seals no authority", () => {
  /**
   * `finalize`'s refusal arm rejects the run and writes no `sealedHashes`, so there is nothing
   * to carry. Without the scope gate the codec would refuse GATE_UNSATISFIED and an
   * authority-bearing run could never be rejected through this seam at all.
   */
  it("rejects an authority-bearing run and writes no envelope", () => {
    const store = proposedStore();
    const refusal = {
      findingsRef: "findings-1", successorRunId: "run-successor-1", truthClass: TRUTH,
    };
    const command = finalizeCommand({ refusal, revision: undefined });
    delete command["revision"];
    const outcome = submit(store, { commands: [command] }, "cmd-finalize-refusal");
    const result = resultOf(outcome);
    expect((result["state"] as Json)["lifecycle"]).toBe("REJECTED");
    expect((eventPayload(store, RUN_ID, FINALIZE_EVENT) as unknown as readonly Json[])
      .map((event) => event["kind"])).toEqual(["PlanningRunRejected"]);
    expect(store.readEvents(AUTHORITY_AGGREGATE).map((event) => event.eventType))
      .toEqual([BODIES_EVENT]);
    expect(store.getAggregateVersion(AUTHORITY_AGGREGATE)).toBe(1);
  });
});

describe("daemon finalize seam — replay", () => {
  it("returns the original result and writes nothing on a byte-identical resubmit", () => {
    const store = proposedStore();
    const first = finalize(store);
    if (!first.ok) throw new Error("the first finalize was refused");
    const after = residueOf(store);
    const second = finalize(store);
    if (!second.ok) throw new Error("the replay was refused");
    expect(decoder.decode(second.decision.resultBytes))
      .toBe(decoder.decode(first.decision.resultBytes));
    expect(second.disposition).toBe("REPLAYED");
    expect(residueOf(store)).toEqual(after);
  });
});
