/**
 * THE OFFER WIRE, direct. Until now this module had no suite of its own — every arm reached it
 * through a port (goal-close-port.test.ts, criterion-evidence-port.test.ts), which tests what a
 * card does with an outcome rather than what the wire makes of a daemon answer.
 *
 * The subject here is the REFUSAL PROJECTION. The daemon sends `{code, detail, layer}` and this
 * module decides what a card is allowed to see. `detail` is the authority's own words — for
 * `release.decide`, `unverified evidence for: <criterionIds>`, the list an operator has to go
 * and fix — and it was being dropped one layer before any card could render it.
 *
 * EVERY ARM ASSERTS AGAINST A DAEMON-SHAPED BODY, never a hand-built outcome: an arm that
 * constructs the answer it expects proves only that the test agrees with itself.
 */
import { describe, expect, it } from "vitest";

import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

const AFFORDANCE = Object.freeze({
  commandKind: "release.decide", expectedVersion: 3, targetAggregateId: "release:goal-1",
});
const PAYLOAD = Object.freeze({ base: "main", decision: "RELEASE", goalId: "goal-1", sha: "a".repeat(40) });
const LAYER = "CONTROL_ROOM_RELEASE";

/** A wire whose transport answers `response`, with a builder that always builds. */
function wireAnswering(response: unknown): OfferWire {
  return {
    client: {
      commands: {
        ["release.decide"]: () => ({ envelope: { commandId: "cmd-1" }, ok: true }),
      },
    },
    sessionCredential: "cred",
    transport: { sendCommand: async () => ({ delivered: true, response }) },
  } as unknown as OfferWire;
}

const spend = async (response: unknown): Promise<OfferOutcome> =>
  spendOffer(wireAnswering(response), "release.decide" as never, AFFORDANCE, PAYLOAD, "ui-release", LAYER);

describe("what a card is told about a daemon refusal", () => {
  it("carries the authority's own words when it sent any", async () => {
    const detail = "unverified evidence for: crit-api, crit-ui";
    await expect(spend({
      ok: false,
      refusal: { code: "RELEASE_EVIDENCE_INCOMPLETE", detail, layer: "DAEMON_PREREQUISITE" },
    })).resolves.toEqual({
      code: "RELEASE_EVIDENCE_INCOMPLETE", detail, layer: "DAEMON_PREREQUISITE", ok: false,
    });
  });

  it("OMITS the key entirely when the daemon sent no detail", async () => {
    // Not `undefined`, not "": every card that compares an outcome by shape must keep seeing
    // exactly what it saw before this field existed, which is what makes the change additive.
    const outcome = await spend({
      ok: false, refusal: { code: "RELEASE_REMOTE_MISSING", layer: "PROJECT_REDUCER" },
    });
    expect(outcome).toEqual({ code: "RELEASE_REMOTE_MISSING", layer: "PROJECT_REDUCER", ok: false });
    expect(Object.keys(outcome).sort()).toEqual(["code", "layer", "ok"]);
    expect("detail" in outcome).toBe(false);
  });

  it("drops a detail that merely echoes the code, which explains nothing", async () => {
    // `domainRefusalOf` falls back to the code when an edge supplies no words of its own, so
    // this shape arrives for real. "X: X" is noise wearing the shape of an explanation.
    const outcome = await spend({
      ok: false, refusal: { code: "OFFER_REFUSED", detail: "OFFER_REFUSED", layer: "DAEMON" },
    });
    expect("detail" in outcome).toBe(false);
  });

  it("drops an empty or non-string detail rather than rendering a blank line", async () => {
    expect("detail" in await spend({
      ok: false, refusal: { code: "X_REFUSED", detail: "", layer: "DAEMON" },
    })).toBe(false);
    expect("detail" in await spend({
      ok: false, refusal: { code: "X_REFUSED", detail: { nested: true }, layer: "DAEMON" },
    })).toBe(false);
  });

  it("keeps every pre-existing path unchanged: code, layer, and the defaults", async () => {
    // The `error` key is the second shape the daemon answers with, and the DAEMON layer default
    // applies when a refusal names none. Both predate this change and must not move.
    await expect(spend({ error: { code: "INPUT_INVALID" }, ok: false }))
      .resolves.toEqual({ code: "INPUT_INVALID", layer: "DAEMON", ok: false });
    await expect(spend({ ok: false })).resolves.toEqual({
      code: "OFFER_REFUSED", layer: "DAEMON", ok: false,
    });
    await expect(spend("not a record")).resolves.toEqual({
      code: "OFFER_ANSWER_UNREADABLE", layer: LAYER, ok: false,
    });
    await expect(spend({ ok: true })).resolves.toEqual({ commandId: "cmd-1", ok: true });
  });

  it("refuses an unbuildable kind at the browser's own layer, before any transport", async () => {
    const wire = {
      client: { commands: {} }, sessionCredential: "cred",
      transport: { sendCommand: async (): Promise<never> => { throw new Error("must not send"); } },
    } as unknown as OfferWire;
    await expect(
      spendOffer(wire, "release.decide" as never, AFFORDANCE, PAYLOAD, "ui-release", LAYER),
    ).resolves.toEqual({ code: "OFFER_KIND_UNBUILDABLE", layer: LAYER, ok: false });
  });
});
