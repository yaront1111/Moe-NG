/**
 * GATE 1 for the epic-final live proof: the planner's two acts, and the human's two clicks.
 *
 * THE SPLIT BETWEEN THEM IS THE POINT. Proposing a contract revision and ASKING a material
 * clarification are what a planning agent does, and they are dispatched on the wire
 * `gate1-v1-approval.spec.ts` uses. ANSWERING the clarification and APPROVING the gate are the
 * human's, and they happen by click in a real Chromium against the shipped bundle -- which is
 * the half DoD 1 is actually about. `product_contract.answer_clarification` is one of the five
 * kinds `daemon-command-registry.ts:392-394` widens for a paired durable HUMAN, so those clicks
 * are the browser's own acts and not the operator's borrowed authority.
 */
import type { Page } from "@playwright/test";

import type { DaemonLane } from "./daemon-ports.js";
import { askDaemon, envelope, isRecord, offerFor, record, sleep } from "./live-proof-arms.js";
import { CLARIFICATION_OPTIONS, CLARIFICATION_QUESTION, CRITERIA, REQUIREMENTS } from "./live-proof-prd.js";

const CARD_SETTLE_MS = 60_000;
const CLICK_MS = 20_000;
const APPROVE_BUDGET_MS = 60_000;

/** The contract triple `design.submit` later needs; gone from the read once Gate 1 commits. */
export type ContractRef = Readonly<Record<string, unknown>> | null;

/** The planner proposes the revision the PRD's requirements and criteria state. */
export async function proposeContract(
  lane: DaemonLane, surface: unknown, goalId: string, contractId: string, prdSha256: string,
): Promise<void> {
  const offer = offerFor(surface, "product_contract.propose_revision", goalId);
  if (offer === null) throw new Error(`no propose_revision offer for ${goalId}`);
  const draft = {
    authorRef: "planner-live-proof",
    contractId,
    // DECLARED IN SORTED ID ORDER, and that is not cosmetic: `admitProductContractRevisionDraft`
    // answers PRODUCT_CONTRACT_PROVENANCE_INVALID @ PROVENANCE for an out-of-order roster.
    // Measured 2026-09-09 by bisection; the ids in `live-proof-prd.ts` carry an ordinal so the
    // PRD's narrative order and the wire's lexicographic order cannot drift apart.
    criteria: CRITERIA.map((row) => ({
      criterionId: row.id, requirementId: row.requirementId, statement: row.statement,
      supersedesCriterionId: null,
    })),
    lineage: null,
    requirements: REQUIREMENTS.map((row) => ({
      requirementId: row.id, statement: row.statement, supersedesRequirementId: null,
    })),
    retiredCriterionIds: [], retiredRequirementIds: [],
    revisionId: "rev-1", sourceDocumentDigests: [prdSha256],
  };
  const proposed = await askDaemon(lane, "/command", envelope(
    offer, "product_contract.propose_revision", "live-proof-propose",
    { draft, goalRef: goalId }, "a", lane.credential,
  ));
  record("contract-proposed", {
    criteria: CRITERIA.length, requirements: REQUIREMENTS.length,
    status: proposed.status, tail: proposed.text.slice(0, 300),
  });
}

/**
 * The planner asks the clarification, and the contract ref is captured before Gate 1 retires it.
 *
 * `product_contract.ask_clarification` has a wired EDGE (`daemon-command-edges.ts:134`) but NO
 * offer on the affordance surface -- measured, `offerFor` returns null -- so the planner mints
 * its own command id against the contract aggregate the Gate 1 approval affordance names.
 */
export async function askClarification(lane: DaemonLane, goalId: string, contractId: string): Promise<ContractRef> {
  const pending = await askDaemon(lane, "/product-contract/pending/read", { goalRef: goalId });
  record("gate1-pending", {
    outcome: isRecord(pending.body) ? pending.body["outcome"] : null,
    tail: pending.text.slice(0, 300),
  });
  record("ask-clarification-offer",
    offerFor((await askDaemon(lane, "/affordances/read", {})).body, "product_contract.ask_clarification"));
  const approval = isRecord(pending.body) && isRecord(pending.body["approval"])
    ? pending.body["approval"]["affordance"] : null;
  if (!isRecord(approval)) return null;
  const minted = {
    commandId: crypto.randomUUID(), expectedVersion: approval["expectedVersion"],
    targetAggregateId: approval["targetAggregateId"],
  };
  record("clarification-target", minted);
  const asked = await askDaemon(lane, "/command", envelope(
    minted, "product_contract.ask_clarification", "live-proof-clarify",
    // Each option carries the whole contract it would produce; core refuses the question outright
    // unless the two projections digest differently, so a prop question cannot be asked at all.
    { contractId, options: CLARIFICATION_OPTIONS.map((row) => ({ ...row })), question: CLARIFICATION_QUESTION },
    "b", lane.credential,
  ));
  record("clarification-asked", { status: asked.status, tail: asked.text.slice(0, 400) });

  const withQuestion = await askDaemon(lane, "/product-contract/pending/read", { goalRef: goalId });
  record("gate1-pending-with-clarification", {
    clarifications: isRecord(withQuestion.body) ? withQuestion.body["clarifications"] : null,
  });
  const ref = isRecord(withQuestion.body) && isRecord(withQuestion.body["ref"])
    ? withQuestion.body["ref"] : null;
  const contractRef: ContractRef = ref === null ? null : {
    contractId: ref["contractId"], revisionDigest: ref["revisionDigest"], revisionId: ref["revisionId"],
  };
  record("contract-ref", contractRef);
  return contractRef;
}

/** The human's half: open the goal, answer the question, approve the gate. */
export async function driveGate1InBrowser(page: Page, lane: DaemonLane, goalId: string): Promise<void> {
  await page.getByTestId(`cr.goals.card.${goalId}.open`).click().catch(() => undefined);
  const card = page.getByTestId("cr.gate1.card");
  const visible = await card.isVisible({ timeout: CLICK_MS }).catch(() => false);
  record("gate1-card-visible", visible);
  if (visible) {
    // The card mounts loading and resolves on its own read. POLLED, not sampled: sampling once
    // reads zero questions while `cr.gate1.loading` is still up, which reads as "the card never
    // renders the clarification" and is simply false.
    const loading = page.getByTestId("cr.gate1.loading");
    const settleBy = Date.now() + CARD_SETTLE_MS;
    while (Date.now() < settleBy && await loading.count() > 0) await sleep(2_000);
    record("gate1-settled", await loading.count() === 0);
    record("gate1-questions-rendered",
      await page.locator("[data-testid^='cr.gate1.question.']").count().catch(() => -1));
    record("gate1-card-text", (await card.innerText().catch(() => "")).slice(0, 700));

    const answer = page.locator("[data-testid^='cr.gate1.answer.']").first();
    if (await answer.count() > 0) {
      await answer.click({ timeout: CLICK_MS }).catch(() => undefined);
      await sleep(2_000);
    }
    const answered = await askDaemon(lane, "/product-contract/pending/read", { goalRef: goalId });
    const rows: unknown = isRecord(answered.body) ? answered.body["clarifications"] : null;
    record("clarification-answered", Array.isArray(rows)
      ? rows.map((row) => isRecord(row)
        ? { answered: row["answered"], id: row["clarificationId"] } : row)
      : rows);

    // THE APPROVE CLICK IS RETRIED AGAINST THE DAEMON, not fired once and hoped for.
    // Answering the clarification re-keys the card, and a single click fired into that
    // re-render lands on a stale affordance: the daemon leaves the contract PENDING and the
    // card shows no refusal, so a one-shot click reports a silent, invisible failure. Observed
    // flaky across runs on 2026-09-09 before this loop existed. The exit condition is the
    // DAEMON's read answering NONE, never the button's own state.
    const approve = page.getByTestId("cr.gate1.approve");
    const approved = page.getByTestId("cr.gate1.approved");
    const refusal = page.getByTestId("cr.gate1.dispatchrefusal");
    const approveBy = Date.now() + APPROVE_BUDGET_MS;
    let attempts = 0;
    while (Date.now() < approveBy) {
      const now = await askDaemon(lane, "/product-contract/pending/read", { goalRef: goalId });
      if ((isRecord(now.body) ? now.body["outcome"] : null) !== "PENDING") break;
      if (await refusal.count() > 0) break;
      if (await approve.count() === 0) { await sleep(1_000); continue; }
      attempts += 1;
      await approve.click({ timeout: CLICK_MS }).catch(() => undefined);
      await sleep(2_000);
    }
    record("gate1-approve-attempts", attempts);
    // The banner says only "That didn't go through"; the CODE lives in the <details> beside it,
    // and a refusal recorded without its code is the vacuous evidence rail 4 forbids.
    await page.evaluate(() => {
      for (const row of document.querySelectorAll("details")) row.setAttribute("open", "");
    }).catch(() => undefined);
    record("gate1-decision", {
      approved: await approved.count(),
      refusalText: await refusal.count() > 0 ? await refusal.innerText() : null,
    });
  }
  const settled = await askDaemon(lane, "/product-contract/pending/read", { goalRef: goalId });
  record("gate1-after", {
    outcome: isRecord(settled.body) ? settled.body["outcome"] : null,
    tail: settled.text.slice(0, 300),
  });
}
