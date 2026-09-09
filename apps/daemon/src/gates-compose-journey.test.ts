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
import { describe, expect, it } from "vitest";

import {
  BASE, GOAL_ID, PROJECT_ID, PR_URL, closeStores, decidePreview, decideRelease, journeyWorld,
  readDesignRevision, readPreviewDecision, readReleaseReceipt, releaseReceiptId, submitDesign,
} from "./gates-journey-fixtures.js";
import { DESIGN_CODE_LAYERS } from "./design/design-contracts.js";
import { designSkipFixture } from "./design/design-test-fixtures.js";
import { OPERATOR } from "./planning/plan-reject-test-fixtures.js";
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
