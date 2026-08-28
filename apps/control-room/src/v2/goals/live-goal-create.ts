import { admitGoalBrief } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { buildGoalBriefCommand } from "@moe/control-room-client";
import type { CommandAffordance } from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import type { GoalCreateResult, GoalDraft } from "./goal-model.js";
import { labelForMissing } from "./work-labels.js";

/**
 * The live Create goal path: the operator's draft becomes the goal.create brief
 * the daemon's own contract admits, and nothing else.
 *
 * Three separations are load-bearing here.
 *  - The AFFORDANCE is the daemon's, verbatim. The identity of the command (its
 *    commandId, target and expected version) is never authored locally; with no
 *    goal.create offer on the surface there is no create to make.
 *  - The BRIEF is the operator's. `briefOfDraft` composes only typed prose plus
 *    the browser's own PRD digest - never a credential, session id or header.
 *  - The VERDICT is the daemon's. Refusals are reported with the code AND the
 *    layer exactly as received; this module never restamps or summarises them.
 */

export interface GoalBriefDraft {
  readonly instructions: string;
  readonly title: string;
}

/**
 * Composes the draft into brief prose. Budget, risk class and PRD lines are
 * ADVISORY REQUESTS written into the instructions - not a budget grant, not a
 * policy class, and not a claim that the PRD was adopted as project material.
 * The PRD digest is the one this browser computed, labelled as such.
 */
export function briefOfDraft(draft: GoalDraft): GoalBriefDraft {
  const lines: string[] = [draft.outcome];
  if (draft.acceptanceCriteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const criterion of draft.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  if (draft.budgetEnvelope !== "") lines.push(`Budget envelope: ${draft.budgetEnvelope}`);
  if (draft.riskClass !== undefined) lines.push(`Risk class: ${draft.riskClass}`);
  if (draft.prd !== undefined) {
    lines.push(
      `PRD: ${draft.prd.name} (${String(draft.prd.size)} bytes) sha256 ${draft.prd.localSha256}`,
    );
  }
  return { instructions: lines.join("\n"), title: draft.title };
}

export function goalCreateOffer(frame: SurfaceFrame | null): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  return frame.offers.find((offer) => offer["commandKind"] === "goal.create") ?? null;
}

/**
 * Why there is no create to make, in words that name a NEXT STEP. A diagnosis on
 * its own ("goal.create is not on the affordance surface") leaves the operator
 * with nothing they can do from the browser, which is the defect this row closes.
 * Every sentence is the daemon's own reading - the prerequisite phrasing comes
 * from `labelForMissing`, never a paraphrase - and none of them may carry a
 * credential, csrf token or header.
 */
export function goalCreateRefusal(frame: SurfaceFrame | null): string {
  if (frame === null || frame.connection !== "CONNECTED") {
    return "goal.create is not available: the board is not connected to the daemon."
      + " Next step: wait for the board to reconnect; if the session expired, pair again from"
      + " the terminal.";
  }
  const step = frame.steps.find((entry) => entry.kind === "goal.create");
  if (step?.status === "BLOCKED" && step.missing.length > 0) {
    return `goal.create is blocked until ${step.missing.map(labelForMissing).join(" and ")}`
      + " commits. Next step: finish the project bootstrap from the terminal (moe init / demo"
      + " seed); the browser cannot drive the pre-activation chain.";
  }
  return `goal.create is not offered by this daemon (step ${step?.status ?? "ABSENT"}).`
    + " Next step: restart the daemon from a build that offers goal.create on every read.";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The daemon's own words for a refusal: its code at its layer, never rewritten. */
function refusalReport(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  const layer = value["layer"];
  if (typeof code !== "string" || code === "") return null;
  return typeof layer === "string" && layer !== "" ? `${code} @ ${layer}` : code;
}

function answerReport(response: unknown): GoalCreateResult {
  if (!isRecord(response)) return { ok: false, report: "unreadable answer" };
  if (response["ok"] === true) {
    const decision = response["decision"];
    const resultCode = isRecord(decision) ? String(decision["resultCode"] ?? "") : "";
    const disposition = isRecord(decision) ? String(decision["disposition"] ?? "") : "";
    return { ok: true, report: `${disposition} ${resultCode}`.trim() || "COMMITTED" };
  }
  const refusal = refusalReport(response["refusal"]) ?? refusalReport(response["error"]);
  return { ok: false, report: refusal ?? "REFUSED" };
}

export function createGoalDispatcher(
  setup: LiveSetup,
  getFrame: () => SurfaceFrame | null,
): (draft: GoalDraft) => Promise<GoalCreateResult> {
  return async (draft: GoalDraft): Promise<GoalCreateResult> => {
    // ONE read of the frame: the refusal must describe the same surface the offer
    // was looked for on, not a later poll's.
    const frame = getFrame();
    const offer = goalCreateOffer(frame);
    if (offer === null) return { ok: false, report: goalCreateRefusal(frame) };
    // The SAME contract the daemon runs, run first here so an inadmissible brief
    // is named at its own layer instead of costing a round trip.
    const admitted = admitGoalBrief(briefOfDraft(draft));
    if (!admitted.ok) return { ok: false, report: `${admitted.code} @ ${admitted.layer}` };

    // Over the NORMALISED payload: the daemon's budget ledger compares this digest
    // to tell an identical retry from a conflicting one, so it must be the digest
    // of the bytes the daemon will actually admit.
    const requestDigest = await sha256Hex(JSON.stringify(admitted.brief));
    const built = buildGoalBriefCommand({
      affordance: offer as unknown as CommandAffordance<"goal.create">,
      correlationId: `ui-goal-create-${requestDigest.slice(0, 16)}`,
      instructions: admitted.brief.instructions,
      requestDigest,
      sessionCredential: setup.sessionCredential,
      title: admitted.brief.title,
    });
    if (!built.ok) {
      const error = "error" in built ? built.error : built;
      return { ok: false, report: refusalReport(error) ?? "COMMAND_BUILD_REFUSED" };
    }
    const envelope = built.envelope as RuntimeCommandEnvelope;
    const sent = await setup.transport.sendCommand(envelope);
    if (!sent.delivered) return { ok: false, report: `UNDELIVERED · ${sent.code}` };
    const answered = answerReport(sent.response);
    return answered.ok ? { ...answered, commandId: envelope.commandId } : answered;
  };
}
