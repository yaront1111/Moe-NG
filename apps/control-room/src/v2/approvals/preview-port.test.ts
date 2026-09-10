import { describe, expect, it, vi } from "vitest";

import {
  createPreviewPort, PREVIEW_COMMAND_KIND, PREVIEW_FINDINGS_REQUIRED,
} from "./preview-port.js";
import type { PreviewWire } from "./preview-port.js";

/**
 * The preview port spends the daemon's offer verbatim and adds only the members
 * `decodePreviewDecidePayload` admits — which are DIFFERENT per decision, and exact: APPROVE is
 * `{decision, previewRef}`, REJECT is `{decision, findings, previewRef}`. The builder and
 * transport are fakes that record what they were handed, so every arm asserts the exact payload
 * that reached the wire rather than what the port meant to send.
 */

/**
 * THE OFFER'S TARGET AND THE RECEIPT ID ARE DELIBERATELY DIFFERENT STRINGS, and they carry the
 * two real shapes: the daemon's offer targets the preview AGGREGATE `preview:<goalId>`
 * (previewAggregateId, preview-receipt-contracts.ts:88) while `preview.decide` resolves
 * `previewRef` as the preview RECEIPT id, a 64-hex digest (HEX64, same file:75). A fixture that
 * used one string for both could not tell which value the port read, and the port could send the
 * goal's aggregate id forever while this arm stayed green.
 */
const OFFER = Object.freeze({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-preview-1",
  commandKind: PREVIEW_COMMAND_KIND, expectedVersion: 2,
  inputSchemaVersion: "moe-preview-command/1", targetAggregateId: "preview:goal-7",
});

/** What `/preview/read` answers and what the daemon expects in `previewRef`. */
const RECEIPT_ID = "4f2b8c1d9e6a70358d41cbf27a09e5341b6d8f0c25a93e7b48c16df502a7be93";

const FINDING = Object.freeze({ detail: "the header overlaps the table", nodeRef: "node-ui" });

function wireWith(answer: unknown, delivered = true): {
  readonly built: unknown[]; readonly sent: unknown[]; readonly wire: PreviewWire;
} {
  const built: unknown[] = [];
  const sent: unknown[] = [];
  const wire = {
    client: { commands: { [PREVIEW_COMMAND_KIND]:
      (affordance: unknown, input: Record<string, unknown>) => {
        built.push({ affordance, input });
        return { envelope: { commandId: OFFER.commandId, payload: input["payload"] }, ok: true };
      } } },
    sessionCredential: "cred-preview-1",
    transport: { sendCommand: vi.fn(async (envelope: unknown) => {
      sent.push(envelope);
      return delivered
        ? { delivered: true as const, response: answer, status: 200 }
        : { code: "TRANSPORT_REQUEST_FAILED", delivered: false as const };
    }) },
  } as unknown as PreviewWire;
  return { built, sent, wire };
}

describe("createPreviewPort", () => {
  it("builds APPROVE with EXACTLY decision and the RECEIPT id the caller supplied",
    async () => {
      const { built, sent, wire } = wireWith({ ok: true });

      const outcome = await createPreviewPort(wire).submit(OFFER, RECEIPT_ID, "APPROVE");

      expect(outcome).toEqual({ commandId: "cmd-preview-1", ok: true });
      const call = built[0] as { affordance: unknown; input: Record<string, unknown> };
      // The affordance is passed through by IDENTITY: the browser never rebuilds the kind,
      // target or expected version the daemon offered.
      expect(call.affordance).toBe(OFFER);
      // EXACT ARITY. `toEqual` on the whole payload, not a property check: a `findings: []`
      // added here "for symmetry" is an unknown key on APPROVE and the daemon refuses it.
      // previewRef is the RECEIPT id, never the affordance's targetAggregateId. Sending the
      // aggregate id answers 422 PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY.
      expect(call.input["payload"]).toEqual({ decision: "APPROVE", previewRef: RECEIPT_ID });
      expect(call.input["sessionCredential"]).toBe("cred-preview-1");
      expect(String(call.input["correlationId"])).toMatch(/^ui-preview-[0-9a-f]{16}$/u);
      expect(sent).toHaveLength(1);
    });

  it("builds REJECT with findings naming the nodes, each finding at its exact arity",
    async () => {
      const { built, wire } = wireWith({ ok: true });

      await createPreviewPort(wire).submit(OFFER, RECEIPT_ID, "REJECT", [
        FINDING, { detail: "the total is off by one", nodeRef: "node-api" },
      ]);

      expect((built[0] as { input: { payload: unknown } }).input.payload).toEqual({
        decision: "REJECT",
        findings: [
          { detail: "the header overlaps the table", nodeRef: "node-ui" },
          { detail: "the total is off by one", nodeRef: "node-api" },
        ],
        previewRef: RECEIPT_ID,
      });
    });

  it("COPIES each finding rather than forwarding the caller's object", async () => {
    const { built, wire } = wireWith({ ok: true });
    const mutable = { detail: "first reading", nodeRef: "node-ui" };

    await createPreviewPort(wire).submit(OFFER, RECEIPT_ID, "REJECT", [mutable]);
    mutable.detail = "changed after submit";

    // A component that reuses its finding state would otherwise rewrite what was sent, and the
    // rendered rejection would disagree with the durable one.
    expect((built[0] as { input: { payload: { findings: unknown } } }).input.payload.findings)
      .toEqual([{ detail: "first reading", nodeRef: "node-ui" }]);
  });

  it("refuses an EMPTY rejection in the browser's own layer, without spending the offer",
    async () => {
      const { built, sent, wire } = wireWith({ ok: true });

      const outcome = await createPreviewPort(wire).submit(OFFER, RECEIPT_ID, "REJECT", []);

      // CODE AND LAYER, and no round trip: the daemon would answer PREVIEW_DECISION_INVALID at
      // REQUEST, which tells the operator nothing about the control they just used. Spending
      // the offer to learn that would also burn the offer.
      expect(outcome).toEqual({
        code: PREVIEW_FINDINGS_REQUIRED, layer: "CONTROL_ROOM_PREVIEW", ok: false,
      });
      expect([built, sent]).toEqual([[], []]);
    });

  it("surfaces a daemon refusal at its OWN code and layer, never swallowed", async () => {
    const refused = wireWith({
      ok: false, refusal: { code: "PREVIEW_DECISION_INVALID", layer: "REQUEST" },
    });

    expect(await createPreviewPort(refused.wire).submit(OFFER, RECEIPT_ID, "APPROVE"))
      .toEqual({ code: "PREVIEW_DECISION_INVALID", layer: "REQUEST", ok: false });
  });

  it("reports a transport failure rather than reading a decision that never landed",
    async () => {
      const down = wireWith(null, false);

      const outcome = await createPreviewPort(down.wire).submit(OFFER, RECEIPT_ID, "APPROVE");

      expect(outcome).toMatchObject({ ok: false });
      expect((outcome as { code: string }).code).not.toBe("");
    });
});
