import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { mapReleaseAnswer } from "../../live/live-release.js";
import type { ReleaseEvidenceView } from "../../live/live-release.js";
import type { OfferWire } from "../approvals/offer-wire.js";
import { GoalRelease, evidenceSummary, releaseOffer } from "./goal-release.js";
import { createReleasePort } from "./release-port.js";

/**
 * THE ARMS THAT MATTER HERE ARE ABOUT WHAT AN OPERATOR IS TOLD BEFORE THEY APPROVE.
 *
 * Gate 3 asks a person whether the evidence is strong enough to expose this work to users.
 * The card can only make that answer informed if it never lets an UNMEASURED criterion pass
 * as a MEASURED one, so the first arm below folds nothing: it asserts the UNKNOWN count is
 * printed as its own visible number beside covered. That is the single assertion this row
 * exists for -- an operator reading "2 of 2 covered" over evidence that was never re-measured
 * would approve a release on the strength of something nobody checked.
 *
 * EVERY EVIDENCE FIXTURE IS DECODED BY THE PRODUCTION DECODER FIRST. `mapReleaseAnswer` is the
 * exact-key reader the browser really runs against `/release/read`; feeding these bodies
 * through it means a fixture that has drifted from the daemon's shape fails HERE, as a decode
 * refusal, instead of silently propping up a green arm over a shape the daemon never sends.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GOAL_ID = "goal-1";
const SHA = "a".repeat(40);
const DOSSIER = "b".repeat(64);
const PR_URL = "https://github.com/owner/unai/pull/42";

/**
 * The daemon's own offer row, spelled exactly as `affordance-planning-offers.ts:144-161`
 * mints it, with the target `releaseDossierAggregateId` DICTATES
 * (release-dossier-contracts.ts:145 returns `release:<goalId>`; `release-decide-command.ts`
 * refuses RELEASE_TARGET_INVALID for anything else). Frozen, because the card spends it
 * verbatim and must not be able to reshape it.
 */
const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "cmd-release-1",
  commandKind: "release.decide",
  expectedVersion: 3,
  inputSchemaVersion: "moe-bootstrap-command/1",
  targetAggregateId: `release:${GOAL_ID}`,
});
const OFFERED = { connection: "LIVE", offers: [OFFER], outcome: "SURFACE", steps: [] } as unknown as SurfaceFrame;
const UNOFFERED = { connection: "LIVE", offers: [], outcome: "SURFACE", steps: [] } as unknown as SurfaceFrame;

interface CriterionSeed {
  readonly gaps: readonly { readonly code: string; readonly criterionId: string; readonly detail: string }[];
  readonly id: string;
}
interface ReceiptSeed {
  readonly outcome: "RELEASED" | "REFUSED";
  readonly prUrl: string | null;
  readonly refusalCode: string | null;
}

function criterionBody(seed: CriterionSeed): Readonly<Record<string, unknown>> {
  return {
    command: "pnpm test", criterionId: seed.id, exitCode: "0", gaps: [...seed.gaps],
    landing: seed.gaps.length === 0 ? SHA : "UNKNOWN", nodeKey: `node-${seed.id}`,
    receiptSha: "c".repeat(40), title: `Criterion ${seed.id}`,
  };
}

/** Builds the `/release/read` PRESENT body and RUNS IT THROUGH THE PRODUCTION DECODER. A
 *  hand-written shape the daemon would never send is refused here rather than rendered. */
function evidenceOf(
  criteria: readonly CriterionSeed[], receipt: ReceiptSeed | null, sha: string | null = SHA,
): ReleaseEvidenceView {
  const body = {
    evidence: {
      ancestryMeasured: true, criteria: criteria.map(criterionBody), goalId: GOAL_ID,
      goalTitle: "Ship the orders screen",
      preview: { decidedAt: "2026-09-06T11:02:44.190Z", decisionId: "decision-preview-1", outcome: "APPROVED", url: "https://preview.local/goal-1" },
      receipt: receipt === null ? null : {
        dossierSha256: DOSSIER, outcome: receipt.outcome, prUrl: receipt.prUrl,
        receiptId: "release-receipt-0123456789", refusalCode: receipt.refusalCode, sha: SHA,
      },
      reviewRounds: [{ nodeKey: "node-a", outcome: "ACCEPTED", refusalCode: null, round: 1 }],
      sha,
    },
    kind: "PRESENT",
  };
  const decoded = mapReleaseAnswer(200, body);
  // The fixture is only a fixture once the real decoder has accepted it.
  if (decoded.status !== "PRESENT") throw new Error(`fixture rejected by mapReleaseAnswer: ${JSON.stringify(decoded)}`);
  return decoded.evidence;
}

const COVERED = { gaps: [], id: "crit-covered" } as const;
const UNMEASURED = {
  gaps: [{ code: "EVIDENCE_UNVERIFIED", criterionId: "crit-unknown", detail: "No verifier receipt cites this criterion." }],
  id: "crit-unknown",
} as const;

/** A wire that records the payload `release-port.ts` builds, so an arm can read the bytes. */
function wireWith(answer: unknown): { readonly built: Record<string, unknown>[]; readonly wire: OfferWire } {
  const built: Record<string, unknown>[] = [];
  const wire = {
    client: { commands: { "release.decide": (affordance: unknown, input: Record<string, unknown>) => {
      built.push({ affordance, ...input });
      return { envelope: { commandId: OFFER.commandId, payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-1",
    transport: { sendCommand: vi.fn(async () => ({ delivered: true as const, response: answer, status: 200 })) },
  } as unknown as OfferWire;
  return { built, wire };
}

describe("releaseOffer and evidenceSummary", () => {
  it("matches the daemon's offer by kind AND by the target the command contract dictates", () => {
    expect(releaseOffer(OFFERED, GOAL_ID)).toBe(OFFER);
    // A different goal's card must never spend this goal's offer.
    expect(releaseOffer(OFFERED, "goal-2")).toBeNull();
    expect(releaseOffer(UNOFFERED, GOAL_ID)).toBeNull();
    expect(releaseOffer(null, GOAL_ID)).toBeNull();
    const wrongKind = { connection: "LIVE", outcome: "SURFACE", steps: [],
      offers: [{ ...OFFER, commandKind: "repository.publish" }] } as unknown as SurfaceFrame;
    expect(releaseOffer(wrongKind, GOAL_ID)).toBeNull();
    const wrongTarget = { connection: "LIVE", outcome: "SURFACE", steps: [],
      offers: [{ ...OFFER, targetAggregateId: GOAL_ID }] } as unknown as SurfaceFrame;
    // `release:<goalId>`, not the bare goal id: a decide on the goal aggregate would overwrite
    // the goal's own state, which is why the daemon refuses RELEASE_TARGET_INVALID for it.
    expect(releaseOffer(wrongTarget, GOAL_ID)).toBeNull();
  });

  it("counts covered and UNKNOWN from the same rows so the two numbers cannot disagree", () => {
    expect(evidenceSummary([])).toStrictEqual({ covered: 0, total: 0, unknown: 0 });
    const criteria = evidenceOf([COVERED, UNMEASURED, UNMEASURED], null).criteria;
    expect(evidenceSummary(criteria)).toStrictEqual({ covered: 1, total: 3, unknown: 2 });
  });
});

describe("GoalRelease evidence summary", () => {
  it("prints the UNKNOWN count as its own number, never folded into covered", () => {
    // THE ARM THIS ROW EXISTS FOR. One criterion measured, one not. If the card summed them as
    // covered the operator would read "2 of 2" and approve evidence nobody re-measured.
    render(<GoalRelease evidence={evidenceOf([COVERED, UNMEASURED], null)} frame={OFFERED} goalId={GOAL_ID} port={null} />);
    const unknown = screen.getByTestId("cr.release.unknown");
    // The rendered TEXT, not an internal value: this is what an operator actually reads.
    expect(unknown.textContent).toContain("UNKNOWN 1 of 2");
    expect(unknown.textContent).toContain("could not be re-measured");
    const covered = screen.getByTestId("cr.release.covered");
    expect(covered.textContent).toContain("Criteria covered 1 of 2");
    // The fold, asserted as an absence: covered must never claim the unmeasured criterion.
    expect(covered.textContent).not.toContain("2 of 2");
    // And the operator is told WHICH criterion is unmeasured, not merely that one is.
    expect(screen.getByTestId("cr.release.gaps").textContent).toContain("crit-unknown");
    expect(screen.getByTestId("cr.release.gaps").textContent).toContain("EVIDENCE_UNVERIFIED");
    // The confirm text carries both numbers too, so the last thing read before approving is
    // the UNKNOWN count rather than a bare "Confirm".
    expect(screen.getByTestId("cr.release.button").textContent).toBe("Approve the release");
  });

  it("says a dossier with NO criteria is empty, never 'covered 0 of 0'", () => {
    // ADVERSARIAL: zero criteria is arithmetically "all covered" and reads like a finished
    // checklist. An operator approving here releases work no criterion ever described, which
    // is the same defect as folding UNKNOWN into covered, wearing different arithmetic.
    render(<GoalRelease evidence={evidenceOf([], null)} frame={OFFERED} goalId={GOAL_ID} port={null} />);
    const covered = screen.getByTestId("cr.release.covered");
    expect(covered.textContent).toContain("No acceptance criteria are attached to this goal");
    expect(covered.textContent).not.toContain("0 of 0");
    expect(screen.queryByTestId("cr.release.unknown")).toBeNull();
    expect(screen.queryByTestId("cr.release.criteria")).toBeNull();
  });

  it("says every criterion is covered, and shows no UNKNOWN line, when nothing is unmeasured", () => {
    render(<GoalRelease evidence={evidenceOf([COVERED, { gaps: [], id: "crit-two" }], null)} frame={OFFERED} goalId={GOAL_ID} port={null} />);
    expect(screen.getByTestId("cr.release.covered").textContent).toContain("Criteria covered 2 of 2");
    // Zero UNKNOWN prints nothing rather than a reassuring "UNKNOWN 0", which would train the
    // eye to skip the line exactly when it is non-zero.
    expect(screen.queryByTestId("cr.release.unknown")).toBeNull();
    expect(screen.getByTestId("cr.release.preview").textContent).toContain("Preview APPROVED");
    expect(screen.getByTestId("cr.release.sha").textContent).toContain(SHA.slice(0, 10));
  });
});

describe("GoalRelease offered and un-offered", () => {
  it("renders with an ENABLED approve control when the daemon offers the decision", async () => {
    const { wire } = wireWith({ ok: true });
    render(<GoalRelease evidence={evidenceOf([COVERED], null)} frame={OFFERED} goalId={GOAL_ID} port={createReleasePort(wire)} />);
    expect(screen.getByTestId("cr.release.root")).not.toBeNull();
    const button = screen.getByTestId("cr.release.button");
    expect(button.hasAttribute("disabled")).toBe(false);
    // Arm first: one click must never dispatch a release.
    await userEvent.click(button);
    expect(screen.getByTestId("cr.release.button").textContent).toContain("Confirm: release 1 covered, 0 UNKNOWN");
  });

  it("renders NOTHING AT ALL when the daemon offers no release.decide and none was taken", () => {
    // DoD 3: absence, not a disabled button. A control that dispatches into a refusal is worse
    // than an honest explanation, and the daemon withholds the offer until a commit has landed.
    render(<GoalRelease evidence={evidenceOf([COVERED], null, null)} frame={UNOFFERED} goalId={GOAL_ID} port={null} />);
    expect(screen.queryByTestId("cr.release.root")).toBeNull();
    expect(screen.queryByTestId("cr.release.button")).toBeNull();
    expect(screen.queryByTestId("cr.release.covered")).toBeNull();
  });

  it("still renders the outcome when the offer is spent but a receipt exists", () => {
    // The offer disappears once the decision is taken; the card must keep showing WHAT happened.
    render(<GoalRelease
      evidence={evidenceOf([COVERED], { outcome: "RELEASED", prUrl: PR_URL, refusalCode: null })}
      frame={UNOFFERED} goalId={GOAL_ID} port={null}
    />);
    expect(screen.getByTestId("cr.release.root")).not.toBeNull();
    expect(screen.queryByTestId("cr.release.button")).toBeNull();
  });
});

describe("GoalRelease receipts", () => {
  it("renders the pull request URL after a RELEASED receipt", () => {
    render(<GoalRelease
      evidence={evidenceOf([COVERED], { outcome: "RELEASED", prUrl: PR_URL, refusalCode: null })}
      frame={OFFERED} goalId={GOAL_ID} port={null}
    />);
    const link = screen.getByTestId("cr.release.link");
    expect(link.getAttribute("href")).toBe(PR_URL);
    expect(link.textContent).toBe(PR_URL);
    expect(screen.getByTestId("cr.release.receipt").textContent).toContain("Released at");
    // The anchors that let a person check the claim: the dossier the decision was taken over.
    expect(screen.getByTestId("cr.release.receipt").textContent).toContain(DOSSIER.slice(0, 12));
    expect(screen.queryByTestId("cr.release.refusal-code")).toBeNull();
  });

  it("renders RELEASE_EVIDENCE_INCOMPLETE VERBATIM, with the criteria that caused it", () => {
    // DoD 2: the LITERAL code, not a paraphrase. A friendly sentence alone would hide which
    // authority refused -- and this code is minted by DAEMON_PREREQUISITE, not by the runner.
    render(<GoalRelease
      evidence={evidenceOf([COVERED, UNMEASURED], { outcome: "REFUSED", prUrl: null, refusalCode: "RELEASE_EVIDENCE_INCOMPLETE" })}
      frame={OFFERED} goalId={GOAL_ID} port={null}
    />);
    expect(screen.getByTestId("cr.release.refusal-code").textContent).toBe("RELEASE_EVIDENCE_INCOMPLETE");
    expect(screen.getByTestId("cr.release.receipt").textContent).toContain("Release refused at");
    // The missing criterion ids reach the operator: the code says a release was refused, these
    // say what to go and fix.
    expect(screen.getByTestId("cr.release.gaps").textContent).toContain("crit-unknown");
    expect(screen.getByTestId("cr.release.unknown").textContent).toContain("UNKNOWN 1 of 2");
    expect(screen.queryByTestId("cr.release.link")).toBeNull();
  });
});

describe("GoalRelease dispatch", () => {
  it("spends the daemon's offer verbatim with EXACTLY the four declared payload keys", async () => {
    const { built, wire } = wireWith({ ok: true });
    render(<GoalRelease evidence={evidenceOf([COVERED], null)} frame={OFFERED} goalId={GOAL_ID} port={createReleasePort(wire)} />);
    await userEvent.click(screen.getByTestId("cr.release.button"));
    await userEvent.click(screen.getByTestId("cr.release.button"));
    await waitFor(() => expect(built).toHaveLength(1));
    // The affordance is the daemon's row, unreshaped: the command fences on target and version.
    expect(built[0]?.["affordance"]).toBe(OFFER);
    const payload = built[0]?.["payload"] as Record<string, unknown>;
    // Exact arity: `daemon-command-payload-keys.ts:173` declares these four and the decoder
    // refuses a fifth key or a missing one.
    expect(Object.keys(payload).sort()).toStrictEqual(["base", "decision", "goalId", "sha"]);
    expect(payload).toStrictEqual({ base: "main", decision: "APPROVE", goalId: GOAL_ID, sha: SHA });
    expect(screen.getByTestId("cr.release.answer").textContent).toContain("pull request link appears here");
  });

  it("renders a refusing daemon's CODE, its LAYER and the criteria it named", async () => {
    const { wire } = wireWith({
      ok: false,
      refusal: { code: "RELEASE_EVIDENCE_INCOMPLETE", detail: "unverified evidence for: crit-unknown, crit-other", layer: "DAEMON_PREREQUISITE" },
    });
    render(<GoalRelease evidence={evidenceOf([COVERED, UNMEASURED], null)} frame={OFFERED} goalId={GOAL_ID} port={createReleasePort(wire)} />);
    await userEvent.click(screen.getByTestId("cr.release.button"));
    await userEvent.click(screen.getByTestId("cr.release.button"));
    const answer = await screen.findByTestId("cr.release.answer");
    // WHICH LAYER REFUSED, asserted with the code: this code is only ever minted by the daemon
    // prerequisite check, and reading it as a runner failure would send the operator to git.
    expect(answer.textContent).toContain("RELEASE_EVIDENCE_INCOMPLETE @ DAEMON_PREREQUISITE");
    expect(screen.getByTestId("cr.release.answer-detail").textContent)
      .toBe("unverified evidence for: crit-unknown, crit-other");
  });
});
