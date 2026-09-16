import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { reviewWorld } from "../orchestrator/wrapper-review-test-fixtures.js";
import {
  createGovernanceDecisionLedger,
  governanceDecisionId,
} from "./governance-decision-ledger.js";
import { decideGovernanceEscalation } from "./governance-escalation-decider.js";
import type { GovernanceAdvisor } from "./governance-escalation-decider.js";
import { GOVERNANCE_PRINCIPAL_ID } from "./governance-policy-settings.js";
import type { GovernancePolicy } from "./governance-policy-settings.js";
import { reviewContinuationAvailable } from "./review-continuation.js";
import { readReviewLedger } from "./review-read-model.js";

/**
 * Governance funding one more attempt, against the REAL world: an approved plan, a sealed graph,
 * bound criteria, a real Git workspace and the shipped wrapper.
 *
 * This is the half that cannot be proven on a lightweight fixture. Guidance only reaches a node
 * when `readReviewGuidanceSource` can join it to a durable submission source, so a suite that
 * stubbed that join would prove governance decided something the node would never actually
 * receive. The decisive assertion here is the last one in the first case: the guidance governance
 * authored appears in the next seat's mission, byte for byte, exactly as a human's would.
 *
 * The live case behind it (UnAI 2026-09-16): one node reported the same unresolved product
 * question on rounds 1, 2, 4 and 5, because only a human could record the answer.
 */

const OPEN: GovernancePolicy = Object.freeze({ kind: "AI_GOVERNOR", maxDecisions: 1 });
const clock = (): string => "2026-09-16T00:00:00.000Z";
const GUIDANCE = "REGISTRY REVIEW - RECORDED DECISION. description is SET; record it in ADR 0011.";

const answers: GovernanceAdvisor = (brief) => ({
  decisions: brief.questions.map((question) => ({
    answer: "shared.obligation.description is SET.",
    basis: "GOVERNANCE_DECIDED" as const,
    citation: null,
    criterionId: question.criterionId,
    findingId: question.findingId,
    question: question.detail,
    rationale: "The product record is silent, and SET is the lossless choice.",
    reviewVersion: brief.reviewVersion,
    subjectRef: brief.subjectRef,
    supersedes: null,
  })),
  guidance: GUIDANCE,
});

/** The preferred outcome: the answer was already in the approved product record. */
const cites: GovernanceAdvisor = (brief) => ({
  decisions: brief.questions.map((question) => ({
    answer: "shared.obligation.description is SET.",
    basis: "PRD_CITED" as const,
    citation: "PRD 26.1",
    criterionId: question.criterionId,
    findingId: question.findingId,
    question: question.detail,
    rationale: "",
    reviewVersion: brief.reviewVersion,
    subjectRef: brief.subjectRef,
    supersedes: null,
  })),
  guidance: GUIDANCE,
});

const worlds: ReturnType<typeof reviewWorld>[] = [];

/** Three unsuccessful rounds with DISTINCT findings: the round cap, not a stall. */
async function exhausted(): Promise<ReturnType<typeof reviewWorld>> {
  const world = reviewWorld();
  worlds.push(world);
  for (let round = 1; round <= 3; round += 1) {
    expect((await world.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
    expect(await world.dispatch(world.requests.at(-1)!, "review.submit", {
      findings: [{
        detail: "Should shared.obligation.description be FUNCTIONAL or SET? An agent cannot decide.",
        ruleId: `registry-review-obligation-description-cardinality-${String(round)}`,
        severity: "MAJOR",
        subject: { kind: "NODE", locator: world.nodeRef },
      }],
      packageItems: [],
      round,
      subjectRef: world.nodeRef,
    }, round - 1)).toMatchObject({ ok: true });
    await world.finishSeat();
  }
  return world;
}

const depsFor = (
  world: ReturnType<typeof reviewWorld>,
  advisor: GovernanceAdvisor,
  policy: GovernancePolicy = OPEN,
) => ({ advisor, clock, policy, projectId: PROJECT_ID, store: world.store });

afterEach(async () => {
  for (const world of worlds) await world.finishSeat();
  closeStores();
  for (const world of worlds.splice(0)) {
    if (!resolve(world.workspace).startsWith(join(resolve(tmpdir()), "moe-wrapper-review-"))) {
      throw new Error("foreign cleanup path");
    }
    rmSync(world.workspace, { force: true, recursive: true });
  }
});

it("funds one more attempt and its guidance reaches the next seat, as a human's would", async () => {
  const world = await exhausted();

  const outcome = decideGovernanceEscalation(depsFor(world, answers), world.nodeRef);

  expect(outcome.kind).toBe("ALLOWED");
  expect(reviewContinuationAvailable(readReviewLedger(world.store, PROJECT_ID, world.nodeRef)))
    .toBe(true);
  // The whole point: the node is staffed again, carrying what governance decided.
  expect((await world.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  const mission = world.requests.at(-1)!.mission;
  expect(mission).toContain("Operator implementation guidance");
  expect(mission).toContain(JSON.stringify(GUIDANCE));
  expect(mission).toContain("not a criterion waiver or verifier proof");
}, 180_000);

it("decides from the reserved governor seat, never from the node under review", async () => {
  // The invariant `review-escalation-authority.test.ts` protects: a node cannot grant itself
  // another attempt. Governance keeps that true by deciding as an id no session can hold.
  const world = await exhausted();
  const version = readReviewLedger(world.store, PROJECT_ID, world.nodeRef).version;

  expect(decideGovernanceEscalation(depsFor(world, answers), world.nodeRef).kind).toBe("ALLOWED");

  const decision = world.store.getCommandDecision({
    commandId: `gov-${governanceDecisionId({
      findingId: "ALLOW_MORE_ATTEMPTS", reviewVersion: version, subjectRef: world.nodeRef,
    })}`,
    principalId: GOVERNANCE_PRINCIPAL_ID,
    projectId: PROJECT_ID,
  });
  expect(decision).not.toBeNull();
  expect(decision?.commandKind).toBe("escalation.decide");
  expect(decision?.effectDisposition).toBe("EFFECTS_COMMITTED");
}, 180_000);

it("writes the decision where a later round and the owner can both read it", async () => {
  const world = await exhausted();

  decideGovernanceEscalation(depsFor(world, answers), world.nodeRef);

  const kept = createGovernanceDecisionLedger(world.store, PROJECT_ID).forSubject(world.nodeRef);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept[0]).toMatchObject({
    answer: "shared.obligation.description is SET.",
    basis: "GOVERNANCE_DECIDED",
    subjectRef: world.nodeRef,
  });
}, 180_000);

it("spends the bound only on what it decided, never on an answer the PRD already gave", async () => {
  // Locating the answer in the approved product record costs the project no new authority, so
  // it must not consume the one decision the owner's policy allowed.
  const world = await exhausted();

  expect(decideGovernanceEscalation(depsFor(world, cites), world.nodeRef).kind).toBe("ALLOWED");

  const records = createGovernanceDecisionLedger(world.store, PROJECT_ID);
  expect(records.forSubject(world.nodeRef).length).toBeGreaterThan(0);
  expect(records.spentOn(world.nodeRef)).toBe(0);
}, 180_000);

it("leaves an already funded attempt alone", async () => {
  const world = await exhausted();
  expect(decideGovernanceEscalation(depsFor(world, answers), world.nodeRef).kind).toBe("ALLOWED");

  // A second pass over the same node must not fund a second attempt on one decision.
  expect(decideGovernanceEscalation(depsFor(world, answers), world.nodeRef))
    .toEqual({ kind: "ALREADY_FUNDED" });
}, 180_000);
