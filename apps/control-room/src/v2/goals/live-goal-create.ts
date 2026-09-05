import { admitGoalBrief, admitGoalSource } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { buildGoalBriefCommand, buildGoalWithSourceCommand } from "@moe/control-room-client";
import type {
  CommandAffordance,
  GoalWithSourceCommandResult,
} from "@moe/control-room-client";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { LiveSetup } from "../../live/live-config.js";
import { readSurfaceOnce } from "../ops/policy-install-port.js";
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
 *  - The SOURCE, when a PRD was selected, travels INSIDE the same command. The
 *    operator's one click is one write: no ingest route is called, so there is
 *    no half-applied pair - a document with no goal, or a goal citing a document
 *    that was never recorded - for a compensating delete to have to undo.
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

/**
 * The two kinds a Create can take. They are separate affordances on the surface,
 * so the daemon may offer one and not the other; the dispatcher asks for the one
 * it intends to send rather than assuming a single create exists.
 */
export type GoalCreateKind = "goal.create" | "goal.create_with_source";

export function goalCreateOffer(
  frame: SurfaceFrame | null, kind: GoalCreateKind = "goal.create",
): Record<string, unknown> | null {
  if (frame === null || frame.outcome !== "SURFACE") return null;
  return frame.offers.find((offer) => offer["commandKind"] === kind) ?? null;
}

/**
 * Why there is no create to make, in words that name a NEXT STEP. A diagnosis on
 * its own ("goal.create is not on the affordance surface") leaves the operator
 * with nothing they can do from the browser, which is the defect this row closes.
 * Every sentence is the daemon's own reading - the prerequisite phrasing comes
 * from `labelForMissing`, never a paraphrase - and none of them may carry a
 * credential, csrf token or header.
 */
export function goalCreateRefusal(
  frame: SurfaceFrame | null, kind: GoalCreateKind = "goal.create",
): string {
  if (frame === null || frame.connection !== "CONNECTED") {
    return `${kind} is not available: the board is not connected to the daemon.`
      + " Next step: wait for the board to reconnect; if the session expired, pair again from"
      + " the terminal.";
  }
  const step = frame.steps.find((entry) => entry.kind === kind);
  if (step?.status === "BLOCKED" && step.missing.length > 0) {
    // NEXT STEP NAMES THE CARD ON THIS SCREEN. Since task-3506e04a the Activate card runs
    // project.register, project.bind_repository, provider.probe and project.activate from one
    // button, so the old sentence -- which sent the operator to `moe init` or the demo seed --
    // was the product's own copy contradicting the product. The prerequisite half still comes
    // from `labelForMissing`, never a paraphrase, and no sentence carries a credential or token.
    return `${kind} is blocked until ${step.missing.map(labelForMissing).join(" and ")}`
      + " commits. Next step: use the Activate project card on this screen; it drives the"
      + " whole chain from the browser.";
  }
  return `${kind} is not offered by this daemon (step ${step?.status ?? "ABSENT"}).`
    + ` Next step: restart the daemon from a build that offers ${kind} on every read.`;
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

/**
 * The daemon's verdict, in the operator's words.
 *
 * THE ACCEPTED CASE IS COPY, NOT THE WIRE'S ENUMS. This used to render the
 * decision's `${disposition} ${resultCode}` pair - "DECIDED EFFECTS_COMMITTED" -
 * straight into the status region a human reads: a durable-ledger term of art
 * presented as if it were a sentence, and one that says nothing about WHICH goal
 * now exists. The title is the admitted one, so the banner names the goal as the
 * daemon stored it rather than as it was typed.
 *
 * REFUSALS ARE DELIBERATELY UNCHANGED. `code @ layer` is the operator's only
 * handle on what to do next, several suites pin it, and softening it would trade
 * a real diagnosis for a pleasantry.
 */
function answerReport(response: unknown, title: string): GoalCreateResult {
  if (!isRecord(response)) return { ok: false, report: "unreadable answer" };
  if (response["ok"] === true) return { ok: true, report: `Goal created: ${title}` };
  const refusal = refusalReport(response["refusal"]) ?? refusalReport(response["error"]);
  return { ok: false, report: refusal ?? "REFUSED" };
}

/**
 * `GoalWithSourceCommandResult` is the wider of the two builder results - it
 * carries both contracts' refusals - so it types either branch without widening
 * anything the brief-only path can actually produce.
 */
type BuiltCommand =
  | { readonly built: GoalWithSourceCommandResult; readonly title: string }
  | { readonly report: string };

/**
 * Shapes the command for whichever kind this draft calls for, admitting every
 * half through the shared contracts FIRST so an inadmissible input is named at
 * its own layer instead of costing a round trip.
 *
 * The request digest covers exactly what was admitted. The daemon's budget
 * ledger compares it to tell an identical retry from a conflicting one, so on
 * the source-carrying path it must move when the PRD moves; digesting the brief
 * alone would make two goals over different documents look like one retry.
 */
async function buildForDraft(
  draft: GoalDraft, offer: Record<string, unknown>, setup: LiveSetup,
): Promise<BuiltCommand> {
  const admitted = admitGoalBrief(briefOfDraft(draft));
  if (!admitted.ok) return { report: `${admitted.code} @ ${admitted.layer}` };
  const prd = draft.prd;
  if (prd === undefined) {
    const requestDigest = await sha256Hex(JSON.stringify(admitted.brief));
    return {
      built: buildGoalBriefCommand({
        affordance: offer as unknown as CommandAffordance<"goal.create">,
        correlationId: `ui-goal-create-${requestDigest.slice(0, 16)}`,
        instructions: admitted.brief.instructions,
        requestDigest,
        sessionCredential: setup.sessionCredential,
        title: admitted.brief.title,
      }),
      title: admitted.brief.title,
    };
  }
  const source = admitGoalSource({
    displayPath: prd.name, mediaType: prd.mediaType, text: prd.text,
  });
  if (!source.ok) return { report: `${source.code} @ ${source.layer}` };
  const requestDigest = await sha256Hex(JSON.stringify([admitted.brief, source.source]));
  return {
    built: buildGoalWithSourceCommand({
      affordance: offer as unknown as CommandAffordance<"goal.create_with_source">,
      correlationId: `ui-goal-create-${requestDigest.slice(0, 16)}`,
      instructions: admitted.brief.instructions,
      requestDigest,
      sessionCredential: setup.sessionCredential,
      source: source.source,
      title: admitted.brief.title,
    }),
    title: admitted.brief.title,
  };
}

/** Reads the affordance surface once. Injectable so a test can drive the re-read. */
export type SurfaceReader = (headers: Readonly<Record<string, string>>) => Promise<SurfaceFrame>;

/**
 * The re-read, made unable to make things worse. `readSurfaceOnce` fetches under a
 * deadline, so it can REJECT (network fault, abort), and it can answer a body that
 * `frameOfSurface` maps to a LAGGING / UNREADABLE frame rather than throwing. Neither
 * is news an operator can act on when a readable frame is already in hand, and refusing
 * on one would replace the prerequisite sentence with a connectivity sentence that is
 * less true. Both degrade to null and the caller keeps the polled frame, so the worst
 * case is the behaviour from before this re-read existed. SurfaceFrame carries no
 * version or timestamp, so "newer" is ordering by REQUEST, not by content: this fetch
 * is issued after the poll that wrote the cached frame.
 */
async function rereadSurface(
  read: SurfaceReader, headers: Readonly<Record<string, string>>,
): Promise<SurfaceFrame | null> {
  try {
    const frame = await read(headers);
    return frame.outcome === "SURFACE" && frame.connection === "CONNECTED" ? frame : null;
  } catch {
    return null;
  }
}

export function createGoalDispatcher(
  setup: LiveSetup,
  getFrame: () => SurfaceFrame | null,
  readSurface: SurfaceReader = readSurfaceOnce,
): (draft: GoalDraft) => Promise<GoalCreateResult> {
  return async (draft: GoalDraft): Promise<GoalCreateResult> => {
    // ONE FRAME PER DECISION: the refusal must describe the same surface the offer was
    // looked for on. Up to two reads reach that frame, never a mix of both. The polled
    // frame is up to POLL_INTERVAL_MS (2 s, live-goals.tsx) old and a prerequisite can
    // commit inside that window - the Activate card drives the whole chain, but a worker
    // seat or a second operator commits one just as easily. Refusing on the cached frame
    // told an operator who clicked promptly to go do the thing they had just done, and
    // never self-corrected: the report is a one-shot submit result, not a polled surface.
    // So with no offer found, read /affordances/read ONCE more and decide on THAT frame -
    // look for the offer on it AND, if still absent, build the refusal from it. Do not
    // "simplify" this back into a single read, and do not reach for `getFrame()` as the
    // second read: it is synchronous over a ref only the poll writes, so a second call
    // returns the same stale object.
    let frame = getFrame();
    // A selected PRD decides the KIND, because the source can only travel inside
    // the command that carries it; with no PRD the brief-only path is unchanged.
    const kind: GoalCreateKind = draft.prd === undefined
      ? "goal.create"
      : "goal.create_with_source";
    let offer = goalCreateOffer(frame, kind);
    if (offer === null) {
      // Only ever on a path that was already about to fail: the happy path makes no
      // extra request, because it never reaches here.
      const reread = await rereadSurface(readSurface, setup.headers);
      if (reread !== null) {
        frame = reread;
        offer = goalCreateOffer(reread, kind);
      }
      if (offer === null) return { ok: false, report: goalCreateRefusal(frame, kind) };
    }
    const prepared = await buildForDraft(draft, offer, setup);
    if ("report" in prepared) return { ok: false, report: prepared.report };
    const built = prepared.built;
    if (!built.ok) {
      const error = "error" in built ? built.error : built;
      return { ok: false, report: refusalReport(error) ?? "COMMAND_BUILD_REFUSED" };
    }
    const envelope = built.envelope as RuntimeCommandEnvelope;
    const sent = await setup.transport.sendCommand(envelope);
    if (!sent.delivered) return { ok: false, report: `UNDELIVERED · ${sent.code}` };
    const answered = answerReport(sent.response, prepared.title);
    return answered.ok ? { ...answered, commandId: envelope.commandId } : answered;
  };
}
