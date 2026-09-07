/**
 * THE IDENTITY PARAMETERS ARE REAL, NOT DECORATIVE.
 *
 * `multi-node-identity.ts` gives the five foundation modules a `MultiNodeIdentity` argument
 * defaulted to the values they have always used, and `worldPrelude` a mode naming which of its
 * three parts to send. Those defaults are proven by `multi-node-graph.e2e.test.ts` staying
 * green. THIS file proves the other half: that a NON-DEFAULT value actually reaches the daemon
 * and changes what it commits, and that the prelude mode selects the part a caller is missing.
 *
 * A parameter never passed a non-default value is untested plumbing. So every assertion here
 * reads the daemon's OWN answer — its committed graph, its coverage frame, its refusal frames —
 * rather than re-reading the arguments this file passed in.
 *
 * NO WALL CLOCK CONSTRAINT APPLIES TO THIS FILE: `e2e-harness.test.ts` scans only non-test
 * modules, and the journey's clock readings have always been the test file's to supply.
 */
import { afterAll, describe, expect, it } from "vitest";

import { killTree, startDaemon } from "./j1-loop-harness.js";
import { createMultiNodeScratch, multiNodeIdentity } from "./multi-node-graph-harness.js";
import type { MultiNodeScratch } from "./multi-node-graph-harness.js";
import { DEFAULT_MULTI_NODE_IDENTITY } from "./multi-node-identity.js";
import type { MultiNodeIdentity } from "./multi-node-identity.js";
import { sealMultiNodeGraph } from "./multi-node-journey.js";
import { goalAggregates, readCoverage, removeMultiNodeScratches, sealedNodes } from "./multi-node-reads.js";
import { daemonWire, send } from "./multi-node-wire.js";
import { worldPrelude } from "./multi-node-world.js";

const JOURNEY_TIMEOUT_MS = 900_000;
const scratches: MultiNodeScratch[] = [];
afterAll(() => removeMultiNodeScratches(scratches));

/**
 * The exact answers the negative controls must get, MEASURED against a live daemon rather than
 * reasoned, and spelled so neither arm can pass on a refusal that has nothing to do with
 * identity. The two differ by design and that difference is the point: a project this daemon
 * does not serve is rejected by the LISTENER before any port sees it, while a credential it
 * does not accept is rejected at AUTHENTICATE — so a single "it refused" assertion would have
 * conflated two entirely different fences.
 */
const WRONG_PROJECT_REFUSAL = {
  code: "LISTENER_AFFORDANCE_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER", stage: null,
};
const WRONG_CREDENTIAL_REFUSAL = {
  code: "AUTHENTICATION_FAILED", layer: null, stage: "AUTHENTICATE",
};

/** The approval's own refusal when the inserted `policy.validate` never landed. */
const POLICY_REF_UNAVAILABLE_REFUSAL = {
  code: "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE", layer: "DAEMON_APPROVAL_INTENT",
  stage: "DISPATCH",
};

/** Nothing here is the default. Every field is a value the journey has never travelled under. */
const OTHER: MultiNodeIdentity = multiNodeIdentity({
  agentSecret: "secret-other-agent",
  agentSession: "sess-other-agent",
  contractId: "other-contract-1",
  correlationId: "corr-other-journey",
  goalCreateCommandId: "other-1",
  humanSecret: "secret-other-human",
  humanSession: "sess-other-human",
  operatorCredential: "moe-e2e-other-operator-credential",
  operatorPrincipal: "operator-other",
  projectId: "moe-e2e-other-project",
  revisionId: "other-revision-1",
});

const clock = (): { nowIso: string; nowMs: number } => {
  const at = new Date();
  return { nowIso: at.toISOString(), nowMs: at.getTime() };
};

/**
 * `operatorPrincipal` is the one identity field a caller may NOT choose unilaterally: the
 * daemon derives the request principal from its own `MOE_PRINCIPAL_ID`
 * (`daemon-store-dependencies.ts:35-47`), and `policy.validate` refuses
 * BOOTSTRAP_POLICY_ACTOR_UNBOUND @ DAEMON_INGRESS when the payload's `actor` disagrees
 * (`bootstrap-policy-services.ts:134-137`) — measured here, not reasoned. So the launcher and
 * the identity are set from the SAME field, which is what a real non-default lane must do.
 */
const environment = (
  scratch: MultiNodeScratch, identity: MultiNodeIdentity,
): Record<string, string> => ({
  MOE_NODE_SPECS_DIR: "", MOE_NODE_TEST_COMMAND: "node test.mjs",
  MOE_NODE_WORKSPACE: scratch.workspace, MOE_PRINCIPAL_ID: identity.operatorPrincipal,
  MOE_WRAPPER_MAX_AGENTS: "2",
});

function freshScratch(identity: MultiNodeIdentity): MultiNodeScratch {
  const scratch = createMultiNodeScratch(identity);
  scratches.push(scratch);
  return scratch;
}

interface Refusal {
  readonly code: unknown;
  readonly layer: unknown;
  readonly stage: unknown;
}

/**
 * WHO refused and WHY, as separate claims. A bare "it refused" is one added fence away from
 * vacuous: a different fence answering first would keep such a test green while it had stopped
 * testing its subject (global rail 1). So every negative here pins the triple.
 *
 * THREE ANSWER SHAPES REACH THIS, and flattening them is the point — `hostile-client.e2e.ts`
 * records the same split. A port refusal carries `refusal.{code,layer}`; an authentication
 * failure is a RuntimeError under `error.code` with NO layer; a listener rejection carries its
 * own. Missing fields normalise to null so an arm states which shape it expects rather than
 * passing on an absent field.
 */
function refusalIn(frame: Record<string, unknown>): Refusal {
  const nested = (key: string): Record<string, unknown> | null => {
    const value = frame[key];
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown> : null;
  };
  const named = nested("refusal") ?? nested("error") ?? frame;
  return {
    code: named["code"] ?? null,
    layer: named["layer"] ?? null,
    stage: named["stage"] ?? frame["stage"] ?? null,
  };
}

/** The same pair, recovered from the transport's throw — `send` stringifies the whole frame. */
function refusalOf(error: unknown): Refusal {
  const message = error instanceof Error ? error.message : String(error);
  const at = message.indexOf("{");
  if (at === -1) throw new Error(`the failure carried no daemon frame: ${message}`);
  return refusalIn(JSON.parse(message.slice(at)) as Record<string, unknown>);
}

describe("the multi-node identity is a parameter the daemon answers on", () => {
  it("seals a graph under a non-default project, goal and credential", async () => {
    const scratch = freshScratch(OTHER);
    // The scratch is the carrier: `j1-loop-harness.ts` maps its projectId and credential into
    // MOE_PROJECT_ID and MOE_DAEMON_CREDENTIAL, so the daemon itself is on the other identity.
    expect(scratch.projectId).toBe(OTHER.projectId);
    expect(scratch.credential).toBe(OTHER.operatorCredential);
    expect(OTHER.goalId).toBe("goal-other-1");
    expect(OTHER.goalId).not.toBe(DEFAULT_MULTI_NODE_IDENTITY.goalId);

    const daemon = await startDaemon(scratch, environment(scratch, OTHER));
    try {
      const wire = daemonWire(daemon.origin, scratch.credential, OTHER.csrfToken);
      const sealed = await sealMultiNodeGraph(scratch, daemon.origin, clock(), {
        identity: OTHER,
      });

      // THE DAEMON'S OWN COMMITTED GRAPH, not the arguments passed in. Every sealed node is
      // bound to the non-default goal, and it is the ONLY goal aggregate in the store.
      expect(goalAggregates(scratch)).toEqual([OTHER.goalId]);
      expect(sealedNodes(scratch)).toEqual([
        { dependsOn: [], goalRef: OTHER.goalId, nodeKey: OTHER.alpha },
        { dependsOn: [], goalRef: OTHER.goalId, nodeKey: OTHER.beta },
        { dependsOn: [OTHER.alpha, OTHER.beta], goalRef: OTHER.goalId, nodeKey: OTHER.omega },
      ]);

      // The daemon's coverage frame answers under the non-default goal with the non-default
      // contract's three criterion ids.
      const coverage = await readCoverage(wire, OTHER.goalId);
      expect(coverage.totals.criteria).toBe(OTHER.criteria.length);
      expect(coverage.criteria.map((row) => row["criterionId"]).sort())
        .toEqual(OTHER.criteria.map((row) => row.criterionId).sort());

      // The run is the DAEMON's, read back off `/criteria/read` under the non-default goal.
      const evidence = await wire.post("/criteria/read", { goalRef: OTHER.goalId });
      expect(evidence["outcome"]).toBe("CRITERION_EVIDENCE");
      expect(evidence["goalRef"]).toBe(OTHER.goalId);
      expect(evidence["planningRunRef"]).toBe(sealed.runId);

      // NEGATIVE CONTROLS, so "it answered" cannot be an identity-blind answer. Each pins the
      // daemon's OWN reason: a bare "it refused" would stay green if some unrelated fence
      // started answering first, which is the whole failure mode global rail 1 names.
      const wrongProject = await wire.post("/affordances/read", {
        projectId: DEFAULT_MULTI_NODE_IDENTITY.projectId,
      });
      expect(wrongProject["outcome"]).not.toBe("SURFACE");
      expect(refusalIn(wrongProject)).toEqual(WRONG_PROJECT_REFUSAL);

      const asDefaultOperator = daemonWire(
        daemon.origin, DEFAULT_MULTI_NODE_IDENTITY.operatorCredential, OTHER.csrfToken,
      );
      const wrongCredential = await asDefaultOperator.post("/affordances/read", {
        projectId: OTHER.projectId,
      });
      expect(wrongCredential["outcome"]).not.toBe("SURFACE");
      expect(refusalIn(wrongCredential)).toEqual(WRONG_CREDENTIAL_REFUSAL);
    } finally {
      await killTree(daemon.child);
    }
  }, JOURNEY_TIMEOUT_MS);

  /**
   * THE NEGATIVE CONTROL FOR THE PRELUDE MODE, and the reason a boolean skip would have been
   * wrong. `SEED_AND_ACTIVATE` sends exactly what the SHIPPED seed sends — installs, activate,
   * and no `policy.validate`. That is the durable state of any lane seeded with the shipped
   * demo seed, and on it the approval MUST refuse for the one specific reason.
   */
  it("refuses the approval with POLICY_REF_UNAVAILABLE at the approval layer when the "
    + "inserted policy.validate is the part that is missing", async () => {
    const scratch = freshScratch(DEFAULT_MULTI_NODE_IDENTITY);
    const daemon = await startDaemon(scratch, environment(scratch, DEFAULT_MULTI_NODE_IDENTITY));
    try {
      // ONE seal only: a second pass on the same store would refuse at `goal.create_with_source`
      // instead, and a test that accepted THAT refusal would be asserting nothing about policy.
      const caught = await sealMultiNodeGraph(scratch, daemon.origin, clock(), {
        preludeMode: "SEED_AND_ACTIVATE",
      }).then(() => null, (error: unknown) => error);
      expect(caught).not.toBeNull();
      // WHICH command refused is pinned beside WHY, so a fence answering earlier in the
      // journey cannot pass this test by refusing for an unrelated reason.
      expect(caught instanceof Error ? caught.message : String(caught))
        .toMatch(/^approval\.decide_intent /u);
      expect(refusalOf(caught)).toEqual(POLICY_REF_UNAVAILABLE_REFUSAL);
    } finally {
      await killTree(daemon.child);
    }
  }, JOURNEY_TIMEOUT_MS);

  /**
   * THE POSITIVE ARM. Same shipped-seed starting state as the negative control, but the caller
   * asks for the ONE part it is missing. The approval then succeeds, which is the whole point
   * of naming the parts instead of skipping the prelude wholesale.
   */
  it("seals the graph on an already-activated project when only the policy.validate is sent",
    async () => {
      const scratch = freshScratch(DEFAULT_MULTI_NODE_IDENTITY);
      const daemon = await startDaemon(scratch, environment(scratch, DEFAULT_MULTI_NODE_IDENTITY));
      try {
        const wire = daemonWire(daemon.origin, scratch.credential);
        // Bring the project to EXACTLY the shipped seed's state: installed and activated,
        // with no `PolicyEvaluated` row anywhere in the store.
        const shipped = worldPrelude(scratch, clock(), DEFAULT_MULTI_NODE_IDENTITY,
          "SEED_AND_ACTIVATE");
        expect(shipped.map((entry) => entry.commandKind)).not.toContain("policy.validate");
        expect(shipped.filter((entry) => entry.commandKind === "policy.install")).toHaveLength(3);
        for (const planned of shipped) await send(wire, planned);

        const sealed = await sealMultiNodeGraph(scratch, daemon.origin, clock(), {
          preludeMode: "POLICY_VALIDATE_ONLY",
        });
        expect(sealed.runId).toMatch(/^run-/u);
        expect(goalAggregates(scratch)).toEqual([DEFAULT_MULTI_NODE_IDENTITY.goalId]);
        expect(sealedNodes(scratch).map((node) => node.nodeKey))
          .toEqual([...DEFAULT_MULTI_NODE_IDENTITY.nodeKeys]);
      } finally {
        await killTree(daemon.child);
      }
    }, JOURNEY_TIMEOUT_MS);
});
