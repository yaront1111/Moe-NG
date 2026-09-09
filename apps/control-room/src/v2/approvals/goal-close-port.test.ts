import { describe, expect, it, vi } from "vitest";

import { createGoalClosePort } from "./goal-close-port.js";
import type { OfferWire } from "./offer-wire.js";

/**
 * The close port spends the daemon's goal.close offer verbatim and sends exactly the three
 * payload keys the kind admits, with witness objects that claim nothing the browser does not
 * hold. The builder and transport are fakes recording what reached them.
 */

/**
 * The daemon's REAL `goal.close` offer, captured verbatim off `POST /affordances/read` on the
 * LIVE UnAI store (project `unai`, 2026-09-05). `commandId` is the daemon-minted UUID, not a
 * hand-written slug, and the six keys are exactly what `affordance-planning-offers.ts` `offer()`
 * emits — the port spends these bytes unchanged, so the fixture has to be the real ones.
 */
const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "c3606f5b-1e81-4b6d-a48d-981ec90d35d8",
  commandKind: "goal.close", expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1",
  targetAggregateId: "goal-c9d9850b-ccef-4c14-8893-a162e3aaf679",
});

function wireWith(answer: unknown, delivered = true): { readonly built: unknown[]; readonly wire: OfferWire } {
  const built: unknown[] = [];
  const wire = {
    client: { commands: { "goal.close": (affordance: unknown, input: Record<string, unknown>) => {
      built.push({ affordance, input });
      return { envelope: { commandId: OFFER.commandId, kind: "goal.close", payload: input["payload"] }, ok: true };
    } } },
    sessionCredential: "cred-live-1",
    transport: { sendCommand: vi.fn(async () => (delivered
      ? { delivered: true as const, response: answer, status: 200 }
      : { code: "TRANSPORT_REQUEST_FAILED", delivered: false as const })) },
  } as unknown as OfferWire;
  return { built, wire };
}

describe("createGoalClosePort", () => {
  it("builds goal.close from the daemon's offer with exactly the three admitted keys", async () => {
    const { built, wire } = wireWith({ ok: true });
    expect(await createGoalClosePort(wire).submit(OFFER, "goal-1"))
      .toEqual({ commandId: OFFER.commandId, ok: true });
    const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
    expect(call.affordance).toBe(OFFER);
    expect(Object.keys(call.input["payload"] as object).sort()).toEqual(["closureWitness", "goalId", "zeroAuthorityWitness"]);
    expect(call.input["payload"]).toEqual({
      closureWitness: { declaredBy: "CONTROL_ROOM", truthClass: "HUMAN_APPROVED" },
      goalId: "goal-1",
      zeroAuthorityWitness: { declaredBy: "CONTROL_ROOM" },
    });
    expect(String(call.input["correlationId"])).toMatch(/^ui-close-[0-9a-f]{16}$/u);
  });

  it("carries the daemon's own refusal and a transport failure at their layers", async () => {
    const refused = wireWith({ ok: false, refusal: { code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", layer: "DAEMON_PREREQUISITE" } });
    expect(await createGoalClosePort(refused.wire).submit(OFFER, "goal-1"))
      .toEqual({ code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED", layer: "DAEMON_PREREQUISITE", ok: false });
    const down = wireWith(null, false);
    expect(await createGoalClosePort(down.wire).submit(OFFER, "goal-1"))
      .toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_TRANSPORT", ok: false });
  });

  /**
   * EVERY REFUSAL THE CLOSE PATH CAN RAISE ARRIVES AS ITS OWN CODE, NEVER SUMMARISED.
   *
   * The first eight are `GOAL_PREREQUISITE_REFUSAL_CODES` (goal-close-prerequisite.ts:44-56),
   * all at `GOAL_PREREQUISITE_LAYER` (:60). The ninth is not a goal code at all:
   * BOOTSTRAP_PREREQUISITE_MISSING is what the LIVE UnAI daemon answered on 2026-09-05 for a
   * goal whose criteria were 10/10 VERIFIED, because `goal.close` requires a committed
   * `approval.decide` (bootstrap-sequence.ts:22) that the project never had, and
   * `bootstrap-services.ts:257-260` refuses ahead of every goal handler. A port that mapped
   * unknown codes onto a friendly default would erase precisely the one an operator cannot
   * guess, so the arm sweeps the whole family and asserts the code SURVIVES the port.
   */
  it.each([
    "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
    "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
    "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS",
    "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE",
    "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
    "GOAL_CLOSE_RESULT_DIGEST_MISMATCH",
    "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
    "GOAL_CLOSE_AUTHORITY_REMAINS",
    "GOAL_CLOSE_CRITERIA_UNVERIFIED",
    "BOOTSTRAP_PREREQUISITE_MISSING",
  ])("passes %s through verbatim at DAEMON_PREREQUISITE", async (code) => {
    const { wire } = wireWith({ ok: false, refusal: { code, layer: "DAEMON_PREREQUISITE" } });
    const outcome = await createGoalClosePort(wire).submit(OFFER, OFFER.targetAggregateId);
    expect(outcome).toEqual({ code, layer: "DAEMON_PREREQUISITE", ok: false });
    // The literal string, not a lookalike: a port that answered a constant would still satisfy
    // a shape check, so the arm pins the exact bytes it was handed.
    expect(outcome.ok).toBe(false);
    expect((outcome as { readonly code: string }).code).toBe(code);
  });

  /**
   * A refusal that names NO code is not silently promoted to one. `answerOf` falls back to
   * OFFER_REFUSED @ DAEMON, which is honest about being the fallback rather than borrowing a
   * real code's authority.
   */
  it("does not invent a code when the daemon's refusal carries none", async () => {
    const { wire } = wireWith({ ok: false, refusal: { layer: "DAEMON_PREREQUISITE" } });
    expect(await createGoalClosePort(wire).submit(OFFER, OFFER.targetAggregateId))
      .toEqual({ code: "OFFER_REFUSED", layer: "DAEMON", ok: false });
  });
});
