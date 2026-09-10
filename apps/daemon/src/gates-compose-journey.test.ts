/**
 * THE THREE HUMAN GATES COMPOSE ON ONE GOAL -- the arms. The world, and the exact statement of
 * what is and is not doubled, live in `gates-journey-fixtures.ts`.
 *
 * Gate 1 (product contract), the design step, Gate 2 (working preview) and Gate 3 (release) are
 * four decisions in ONE operator's sequence. Each band row proved its own decision; this file is
 * the only place the SEQUENCE exists, and it could not be written until every band had landed.
 *
 * EVERY END STATE IS READ BACK FROM THE STORE through a production reader, never from the
 * command's return value: a `DurableDecision` carries no verdict, so an arm asserting on it would
 * prove only that the function returned.
 *
 * WHICH ORDERINGS ARE PROVEN BY REFUSAL, AND WHICH EDGE IS DELIBERATELY NOT ONE. Every
 * out-of-order attempt below asserts the specific code AND the layer that answered, never merely
 * that the call failed. The Gate 2 -> Gate 3 edge is NOT among them, and it must not become one:
 * the owner's direction of 2026-09-09 is "we can approve the plan at the start but that's it", so
 * release is decided on MACHINE EVIDENCE alone and a REJECTED or absent preview verdict is
 * RENDERED into the pull request rather than enforced. An external reviewer prescribed a
 * preview-required refusal here and the owner overruled it; release-decide-service.ts's closed
 * code map is still exactly three codes, and release-decide-service.test.ts pins both directions.
 * This header used to claim that edge was proven by refusal while no arm asserted it.
 *
 * What Gate 3 DOES refuse is a sha nothing was proven at, and a SECOND approval of a sha this goal
 * already released.
 */
import { POLICY_AUTO_APPROVAL_TIERS, POLICY_RISK_TIERS } from "@moe/core";
import { describe, expect, it } from "vitest";

import {
  BASE, GOAL_ID, PROJECT_ID, PR_URL, closeStores, decidePreview, decideRelease, journeyWorld,
  readDesignRevision, readPreviewDecision, readReleaseReceipt, releaseReceiptId, submitDesign,
} from "./gates-journey-fixtures.js";
import {
  autoPreviewDecision, landedNodeRef, markPushed, onlyOutcome, releaseAutoDepsOver,
  releaseDecidedCount, resolveUnattendedPreview, startPreviewUnattended, unattendedWorld,
} from "./gates-unattended-fixtures.js";
import { DESIGN_CODE_LAYERS } from "./design/design-contracts.js";
import { designSkipFixture } from "./design/design-test-fixtures.js";
import { OPERATOR } from "./planning/plan-reject-test-fixtures.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview/preview-contracts.js";
import { previewAutoDecline } from "./preview/preview-auto-decision.js";
import { RELEASE_AUTO_CODE_LAYER_MAP } from "./release/release-auto-approval.js";
import { GAP_SENTENCES } from "./release/release-dossier-sections.js";
import type { DossierGapCode } from "./release/release-dossier-sections.js";
import { OTHER_SHA } from "./release/release-dossier-fixtures.js";
import { releaseAutoDecideOnce } from "./release/release-auto-decide.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release/release-decide-contracts.js";
import { afterEach } from "vitest";

afterEach(closeStores);

const APPROVE = (previewRef: string): Readonly<Record<string, unknown>> =>
  ({ decision: "APPROVE", previewRef });

const releasePayload = (sha: string): Readonly<Record<string, unknown>> =>
  ({ base: BASE, decision: "APPROVE", goalId: GOAL_ID, sha });

/** The durable verdict Gate 2 left, through the production decision reader. */
function previewVerdict(world: ReturnType<typeof journeyWorld>, commandId: string): unknown {
  return readPreviewDecision(world.store, PROJECT_ID, OPERATOR, commandId)?.decision ?? null;
}

/** The durable receipt Gate 3 left, through the production receipt ledger. */
function releasedReceipt(world: ReturnType<typeof journeyWorld>): unknown {
  const read = readReleaseReceipt(
    world.store, PROJECT_ID, releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
  );
  return read.ok ? read.receipt : { code: read.code };
}

describe("one goal passes Gate 1, the design step, Gate 2 and Gate 3 in sequence", () => {
  it("reaches a released end state with a design on the record", async () => {
    const world = journeyWorld("SUBMITTED");

    // THE DESIGN IS ON THE RECORD, read through the production reader rather than inferred from
    // the submit's return value.
    const design = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(design.ok).toBe(true);

    // GATE 2 -- the operator approves the working preview.
    const preview = decidePreview(world, APPROVE(world.previewRef));
    expect(preview.answer).toMatchObject({
      decision: { disposition: "DECIDED" }, outcome: "ACCEPTED",
    });
    expect(previewVerdict(world, preview.commandId)).toBe("APPROVE");

    // GATE 3 -- the operator approves the release. The receipt is the durable end state.
    const release = await decideRelease(world, releasePayload(world.sha));
    expect(release.answer).toMatchObject({ outcome: "ACCEPTED" });
    expect(releasedReceipt(world)).toMatchObject({
      goalId: GOAL_ID, outcome: "RELEASED", prUrl: PR_URL, sha: world.sha,
    });
  });

  it("reaches the SAME released end state with the design SKIPPED", async () => {
    const world = journeyWorld("SKIPPED");

    // THE SKIP IS A RECORDED STATE, never inferred from an absence: it travels the same command,
    // the same decoder and the same aggregate an authored design does, and the record says so.
    const design = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    if (!design.ok) throw new Error(`the skip record is unreadable: ${design.code}`);
    expect(design.record.revision).toMatchObject({ skipped: true });

    const preview = decidePreview(world, APPROVE(world.previewRef));
    expect(previewVerdict(world, preview.commandId)).toBe("APPROVE");

    const release = await decideRelease(world, releasePayload(world.sha));
    expect(release.answer).toMatchObject({ outcome: "ACCEPTED" });
    expect(releasedReceipt(world)).toMatchObject({ goalId: GOAL_ID, outcome: "RELEASED" });
  });

  it("differs between the two variants exactly where the design step should change things", () => {
    // Two paths that produced byte-identical end states would mean the design step changed
    // NOTHING, which is a finding rather than a pass. Asserted as a pair so the comparison
    // cannot silently degenerate into comparing a value with itself.
    const submitted = journeyWorld("SUBMITTED");
    const submittedDesign = readDesignRevision(
      submitted.store, { goalRef: GOAL_ID, projectId: PROJECT_ID },
    );
    closeStores();
    const skipped = journeyWorld("SKIPPED");
    const skippedDesign = readDesignRevision(
      skipped.store, { goalRef: GOAL_ID, projectId: PROJECT_ID },
    );
    if (!submittedDesign.ok || !skippedDesign.ok) {
      throw new Error("a design record the journey wrote is unreadable");
    }
    // The design the plan was built on is PRESENT in one and explicitly declared absent in the
    // other. Byte-identical end states would mean the design step changed nothing at all.
    expect(submittedDesign.record.revision).not.toEqual(skippedDesign.record.revision);
    expect(skippedDesign.record.revision).toMatchObject({ skipped: true });
    expect(submittedDesign.record.revision).not.toMatchObject({ skipped: true });
  });
});

describe("a gate taken out of order refuses with its own code and layer", () => {
  it("refuses Gate 2 for a preview reference that was never issued", () => {
    const world = journeyWorld("SUBMITTED");
    // The preview receipt is the evidence a preview EXISTS to judge. Naming one that was never
    // issued is the out-of-order shape Gate 2 can actually see, and it must name the preview
    // vocabulary's own layer rather than a generic seam refusal.
    const answer = decidePreview(world, APPROVE("preview-never-issued")).answer;
    expect(answer).toMatchObject({
      ok: false,
      refusal: { code: "PREVIEW_GOAL_NOT_LANDED", layer: "GOAL_AUTHORITY" },
    });
  });

  it("refuses Gate 3 for a sha that carries no landed evidence", async () => {
    const world = journeyWorld("SUBMITTED");
    const answer = (await decideRelease(world, releasePayload("e".repeat(40)))).answer;
    // RELEASE_EVIDENCE_INCOMPLETE with its own layer, from the release vocabulary's closed
    // code->layer map: this goal's landings are not ancestors of the named sha, so nothing
    // proves the product was ever built at it.
    expect(answer).toMatchObject({
      ok: false,
      refusal: { code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" },
    });
    expect(releasedReceipt(world)).toMatchObject({ code: "RELEASE_RECEIPT_NOT_FOUND" });
  });

  it("refuses a SECOND Gate 3 approval of a sha this goal already released", async () => {
    const world = journeyWorld("SUBMITTED");
    expect((await decideRelease(world, releasePayload(world.sha))).answer)
      .toMatchObject({ outcome: "ACCEPTED" });
    // KEPT, AND THIS IS THE ARM THAT MATTERS FOR THE UNATTENDED PATH. The replay fence is answered
    // from the ADMISSION journal, not from the receipt: a fresh command id at an already-released
    // sha is a second release, not a retry of the first. With a human at the keyboard a duplicate
    // approval is a mis-click; once a policy engine can approve a release with no human in the
    // loop, this fence is the only thing between a retried command and a second pull request.
    expect((await decideRelease(world, releasePayload(world.sha))).answer).toMatchObject({
      ok: false,
      refusal: { code: "RELEASE_COMMAND_ID_REQUIRED", layer: "DAEMON_COMMAND_SEAM" },
    });
  });

  it("refuses a HALF-SKIPPED design with the design slice's own code and layer", () => {
    // The skip's EXACT arity is what makes a half-skipped value unrepresentable
    // (design-contracts.ts:49-53). A record carrying both the marker and sections is the shape a
    // caller reaches for when it wants "skipped, but here is the design anyway", and admitting it
    // would leave the compiler unable to say whether a design was authored.
    const world = journeyWorld("OMITTED");
    const answer = submitDesign(world.deps, world.ref,
      { ...designSkipFixture(), screens: [] }, "sess-journey-half-skip");
    expect(answer).toMatchObject({
      ok: false,
      refusal: { code: "DESIGN_SHAPE_INVALID", layer: DESIGN_CODE_LAYERS.DESIGN_SHAPE_INVALID },
    });
    // And it wrote NOTHING: a refusal that still recorded a revision would be the worse failure.
    expect(readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID }))
      .toMatchObject({ code: "DESIGN_REVISION_ABSENT", ok: false });
  });
});

/**
 * ONE APPROVAL, THEN UNATTENDED. The same goal, the same four-decision sequence -- except the
 * operator's ONLY keystroke is Gate 1, and Gates 2 and 3 close on machine evidence under the
 * standing opt-ins they earned there. The owner's direction of 2026-09-09 is the specification:
 * "we can approve the plan at the start but that's it".
 *
 * WHAT MAKES THESE ARMS TEST THIS ROW'S SUBJECT RATHER THAN THE GATES THEMSELVES. A
 * `decision: "APPROVE"` or an `outcome: "RELEASED"` assertion passes IDENTICALLY against the human
 * sequence above, so on its own it would prove nothing new. Both persisted records carry a
 * `provenance` that is NULL for a human by their own contracts
 * (preview-decision-record.ts:83-84, release-decide-service.ts:133-135), so every arm below
 * asserts the recorded action and tier VALUES -- the one thing that says a machine decided, and
 * the one thing a reviewer reads to tell the two apart.
 *
 * AND NO ARM HERE CALLS `decidePreview` OR `decideRelease` ON THE HAPPY PATH. The absence of an
 * operator command in the arm IS the "zero further human decisions" claim; the provenance
 * assertions are what prove the decisions were nonetheless taken.
 */
describe("one approval at Gate 1, then Gates 2 and 3 close with no human", () => {
  it("auto-approves the preview and auto-releases the PR, each NAMING its opt-in", async () => {
    const world = unattendedWorld();

    // GATE 2 -- the production `preview.start` seam, which is where an automatic decision hangs
    // off. No operator decision is submitted here or anywhere below.
    const receiptId = await startPreviewUnattended(world);
    const decision = autoPreviewDecision(world, receiptId);
    if (decision === null) throw new Error("Gate 2 left no automatic decision on the record");
    expect(decision.decision).toBe("APPROVE");
    // The subject is R0 and the standing opt-in covers R1; the record names WHAT IT ACTED UNDER.
    expect(decision.provenance).toEqual({ action: PREVIEW_DECIDE_COMMAND_KIND, tier: "R0" });

    // GATE 3 -- one tick of the reconciler over the pushed candidate. Again no human command.
    markPushed(world);
    const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
    expect(answer.code).toBe("RELEASED");

    // THE DURABLE END STATE, through the production receipt ledger rather than the tick's return
    // value: the released pull request, and the opt-in the release was taken under.
    const receipt = readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    );
    if (!receipt.ok) throw new Error(`expected a RELEASED receipt, got ${receipt.code}`);
    expect(receipt.receipt).toMatchObject({
      goalId: GOAL_ID, outcome: "RELEASED", prUrl: PR_URL, sha: world.sha,
    });
    expect(receipt.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
    // ZERO FURTHER HUMAN DECISIONS, asserted against the JOURNAL rather than inferred from the
    // fact that this arm submitted none: the release aggregate holds exactly ONE decision. Two
    // would mean the reconciler dispatched twice, or that a human decision is hiding behind the
    // automatic one and the receipt above belongs to the wrong decider.
    expect(releaseDecidedCount(world)).toBe(1);
  });

  it("leaves a HUMAN sequence's records provenance-free, so the two are distinguishable", async () => {
    // THE CONTROL, and it is not decoration: it is what stops the arm above from passing on a
    // build where `provenance` is stamped onto every decision regardless of who decided. The
    // human journey and the unattended one differ in exactly this field.
    const world = journeyWorld("SUBMITTED");
    const preview = decidePreview(world, APPROVE(world.previewRef));
    const human = readPreviewDecision(world.store, PROJECT_ID, OPERATOR, preview.commandId);
    if (human === null) throw new Error("the human Gate 2 decision is unreadable");
    expect(human.decision).toBe("APPROVE");
    expect(human.provenance).toBeNull();

    expect((await decideRelease(world, releasePayload(world.sha))).answer)
      .toMatchObject({ outcome: "ACCEPTED" });
    const receipt = readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    );
    if (!receipt.ok) throw new Error(`expected a RELEASED receipt, got ${receipt.code}`);
    expect(receipt.receipt.provenance).toBeNull();
  });
});

/**
 * R2 AND R3 ARE HUMAN-ONLY, AND THIS ROW DOES NOT WIDEN THAT. The engine's own rule
 * (`assessTier`, policy-evaluation.ts:150-166) is the authority; nothing in the daemon re-derives
 * it. These arms prove BOTH gates stay pending for a human on an elevated subject, and each names
 * the code AND the layer that answered rather than merely that nothing was approved -- five
 * conditions can decline Gate 2 and six can decline Gate 3, so "it did not approve" is one
 * regression away from vacuous.
 */
describe("a subject at R2 or R3 is not auto-approved at either gate", () => {
  it.each(["R2", "R3"] as const)(
    "leaves Gate 2 pending for a human at %s, naming the engine's own reason code",
    async (subjectTier) => {
      const world = unattendedWorld({ subjectTier });
      const receiptId = await startPreviewUnattended(world);
      // PENDING, not decided: the production seam ran and committed nothing.
      expect(autoPreviewDecision(world, receiptId)).toBeNull();
      // And WHY. The pair is read from `previewAutoDecline`, because the code->layer map itself
      // is module-private -- a call site cannot pair a code with a layer the vocabulary rejects.
      const resolved = resolveUnattendedPreview(world);
      if (resolved.ok) throw new Error("an R2/R3 subject was auto-approved at Gate 2");
      const expected = previewAutoDecline("PREVIEW_AUTO_NOT_ALLOWED");
      expect({ code: resolved.code, layer: resolved.layer })
        .toEqual({ code: expected.code, layer: expected.layer });
      expect(resolved.reasonCodes).toContain("HUMAN_ONLY_TIER");
    },
  );

  it.each(["R2", "R3"] as const)(
    "leaves Gate 3 pending for a human at %s, with the release vocabulary's code and layer",
    async (subjectTier) => {
      const world = unattendedWorld({ subjectTier });
      markPushed(world);
      const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
      expect(answer.code).toBe("NOT_ALLOWED");
      expect(answer.refusal).toEqual({
        code: "RELEASE_AUTO_NOT_ALLOWED",
        layer: RELEASE_AUTO_CODE_LAYER_MAP.RELEASE_AUTO_NOT_ALLOWED,
      });
      expect(answer.detail.split(", ")).toContain("HUMAN_ONLY_TIER");
      // Nothing was released and nothing was written: the gate is genuinely still a human's.
      expect(readReleaseReceipt(
        world.store, PROJECT_ID,
        releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
      ).ok).toBe(false);
    },
  );

  it("keeps the automatic ceiling at R0/R1, with R2 and R3 its exact complement", () => {
    // The constant itself, imported from the @moe/core bare specifier: this row installs opt-ins,
    // it does not widen what may be opted into.
    expect([...POLICY_AUTO_APPROVAL_TIERS]).toEqual(["R0", "R1"]);
    // SET EQUALITY BOTH DIRECTIONS, which a subset check would not give: every risk tier is either
    // automatable or human-only, and the human-only half is exactly R2 and R3. A fifth tier added
    // upstream without a ruling reddens here instead of silently landing on one side.
    const automatic = new Set<string>(POLICY_AUTO_APPROVAL_TIERS);
    expect(POLICY_RISK_TIERS.filter((tier) => !automatic.has(tier))).toEqual(["R2", "R3"]);
    expect(POLICY_RISK_TIERS.filter((tier) => automatic.has(tier)))
      .toEqual([...POLICY_AUTO_APPROVAL_TIERS]);
  });
});

/**
 * A HUMAN REJECT WINS OVER A STANDING OPT-IN -- at the gate the human decided, and nowhere else.
 *
 * WHY THESE ARMS NAME THE LAYER. Both gates can decline an automatic decision for five or six
 * different reasons, so an arm asserting only that nothing was auto-approved would stay green if a
 * second refusal layer started answering first -- it would no longer be testing PRECEDENCE at all,
 * which is this row's actual subject. Each arm below therefore pins the specific code AND the
 * surface that minted it, and the drill recorded on this row mutates exactly that check to prove
 * the arms go red when it is gone.
 */
describe("a human REJECT wins over a standing opt-in", () => {
  it("does not overturn a human REJECT at Gate 2, and names the surface that refused", async () => {
    const world = unattendedWorld();
    // The human decides FIRST, through the production registry, citing a node the goal landed.
    const rejected = decidePreview(world, {
      decision: "REJECT",
      findings: [{ detail: "the header is unreadable", nodeRef: landedNodeRef(world) }],
      previewRef: world.previewRef,
    });
    expect(rejected.answer).toMatchObject({ outcome: "ACCEPTED" });
    const human = readPreviewDecision(world.store, PROJECT_ID, OPERATOR, rejected.commandId);
    expect(human).toMatchObject({ decision: "REJECT", provenance: null });

    // The automatic path then runs over the same world and MUST NOT overturn it.
    const receiptId = await startPreviewUnattended(world);
    expect(autoPreviewDecision(world, receiptId)).toBeNull();
    const resolved = resolveUnattendedPreview(world);
    if (resolved.ok) throw new Error("the automatic path overturned a human REJECT");
    const expected = previewAutoDecline("PREVIEW_AUTO_ALREADY_DECIDED");
    expect({ code: resolved.code, layer: resolved.layer })
      .toEqual({ code: expected.code, layer: expected.layer });
    // The engine was never even asked: this is the daemon's own precedence check, not a policy
    // verdict, and an empty reasonCodes list is what says so.
    expect(resolved.reasonCodes).toEqual([]);
    // AND THE HUMAN'S VERDICT IS STILL THE RECORD.
    expect(readPreviewDecision(world.store, PROJECT_ID, OPERATOR, rejected.commandId))
      .toMatchObject({ decision: "REJECT" });
  });

  it("does not overturn a human REJECT at Gate 3, with the seam's own code and layer", async () => {
    const world = unattendedWorld();
    markPushed(world);
    const rejected = await decideRelease(world, {
      base: BASE, decision: "REJECT", goalId: GOAL_ID, sha: world.sha,
    });
    expect(rejected.answer).toMatchObject({ outcome: "ACCEPTED" });

    const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
    expect(answer.code).toBe("HUMAN_REJECTED");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_COMMAND_ID_REQUIRED", layer: "DAEMON_COMMAND_SEAM" });
    expect(answer.detail).toContain(OPERATOR);
    // Nothing was released: the human's REJECT is still the goal's terminal.
    expect(readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    ).ok).toBe(false);
  });

  it("but a REJECTED PREVIEW does not fence Gate 3 -- the owner's 2026-09-09 ruling", async () => {
    // NOT AN OVERSIGHT, AND NOT SAFE TO 'FIX'. An external reviewer prescribed a preview-required
    // refusal at Gate 3 and the owner overruled it: release is decided on MACHINE EVIDENCE, and a
    // REJECTED preview verdict is RENDERED into the pull request rather than enforced. This arm
    // exists so that ruling is pinned on the UNATTENDED path too, where the temptation to add the
    // fence is strongest. Gate 2's REJECT still wins at GATE 2 -- the arm above proves that.
    const world = unattendedWorld();
    decidePreview(world, {
      decision: "REJECT",
      findings: [{ detail: "the header is unreadable", nodeRef: landedNodeRef(world) }],
      previewRef: world.previewRef,
    });
    markPushed(world);
    const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
    expect(answer.code).toBe("RELEASED");
    const receipt = readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    );
    if (!receipt.ok) throw new Error(`expected a RELEASED receipt, got ${receipt.code}`);
    expect(receipt.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
  });
});

/**
 * THE DEFECT THE 2026-09-09 EXTERNAL REVIEW FOUND: auto-releasing on evidence WEAKER than goal
 * closure demands. `task-b8ec9a63` bound the release dossier to criterion receipts at the released
 * sha; these arms prove the unattended path is decided on THAT dossier and refuses without it.
 *
 * THE CODE IS NOT INVENTED HERE. `CRITERION_GAP` is typed as `DossierGapCode`, so a rename in the
 * landed vocabulary is a COMPILE error rather than a silently-never-matching string, and the arm
 * additionally asserts the code is a live key of the exported `GAP_SENTENCES` map. The gap itself
 * is DETECTED by production: nothing here re-implements `releaseDossierGaps`, which would prove
 * only that the test agrees with itself.
 */
describe("a criterion gap is not auto-released, even under a valid opt-in", () => {
  const CRITERION_GAP: DossierGapCode = "CRITERION_NOT_VERIFIED_AT_SHA";

  it("refuses the gap-bearing sha with the landed gap code and the prerequisite layer", async () => {
    const world = unattendedWorld();
    // A sha the goal's criterion receipts do not bind to. Everything else about this world is the
    // world that DOES auto-release in the control arm below.
    markPushed(world, OTHER_SHA);
    const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
    expect(answer.sha).toBe(OTHER_SHA);
    expect(answer.code).toBe("EVIDENCE_INCOMPLETE");
    expect(answer.refusal)
      .toEqual({ code: "RELEASE_EVIDENCE_INCOMPLETE", layer: "DAEMON_PREREQUISITE" });
    expect(answer.detail.split(", ")).toContain(CRITERION_GAP);
    // The code is the DELIVERED vocabulary's, not a string this file made up.
    expect(GAP_SENTENCES[CRITERION_GAP])
      .toContain("no passed criterion check binds this criterion");
    // And nothing was released at that sha.
    expect(readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, OTHER_SHA, "RELEASED", null),
    ).ok).toBe(false);
  });

  it("THE CONTROL: the same opt-in DOES release the criterion-bound sha", async () => {
    // Without this, the arm above would pass just as well on a build where the opt-in never
    // matched anything -- the refusal would be "not opted in" wearing an evidence code's clothes.
    // MEASURED, and the reason this control is not capped at R0: the release subject is the
    // journey's own R1 planning-run tier, and `tierRank(entry.tier) >= tierRank(tier)` means an
    // R0-capped opt-in covers NO R1 subject at all. Pinning the gap "under an R0 opt-in" would
    // therefore have tested tier ranking, which child C already arms, rather than evidence.
    const world = unattendedWorld();
    markPushed(world);
    const answer = onlyOutcome(await releaseAutoDecideOnce(releaseAutoDepsOver(world)));
    expect(answer.code).toBe("RELEASED");
    const receipt = readReleaseReceipt(
      world.store, PROJECT_ID,
      releaseReceiptId(PROJECT_ID, GOAL_ID, world.sha, "RELEASED", null),
    );
    if (!receipt.ok) throw new Error(`expected a RELEASED receipt, got ${receipt.code}`);
    expect(receipt.receipt.provenance)
      .toEqual({ action: RELEASE_DECIDE_COMMAND_KIND, tier: "R1" });
  });
});
