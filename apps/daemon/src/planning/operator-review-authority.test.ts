import { describe, expect, it } from "vitest";

import { humanReviewWitness } from "../bootstrap/bootstrap-ledger.js";
import { readApprovalPolicySettings } from "./approval-policy-settings.js";
import { operatorReviewAuthority } from "./operator-review-authority.js";

const DECIDED_AT = "2026-09-17T04:00:00.000Z";
const REQUIRE_HUMAN = readApprovalPolicySettings({});
const SPEED = readApprovalPolicySettings({
  MOE_APPROVAL_MODE: "SPEED", MOE_SPEED_MODE_DELAY_MS: "250",
});

describe("operatorReviewAuthority mints from the witness and re-derives the verdict", () => {
  it("answers a REQUIRE_HUMAN policy with a HUMAN grant bound to the run's review gate", () => {
    const decided = operatorReviewAuthority(
      humanReviewWitness("operator-1", "cmd-1"), "run-7", DECIDED_AT, REQUIRE_HUMAN,
    );

    expect(REQUIRE_HUMAN.kind).toBe("REQUIRE_HUMAN");
    expect(decided).toEqual({
      delayMs: 0,
      grant: {
        gateId: "approval-review:run-7",
        grantedAtEpochMs: Date.parse(DECIDED_AT),
        principalId: "operator-1",
        principalKind: "HUMAN",
        workRef: "run-7",
      },
      ok: true,
    });
  });

  it("lets the granted gate outrank the policy, so a SPEED delay never reaches the verdict", () => {
    const decided = operatorReviewAuthority(
      humanReviewWitness("operator-1", "cmd-1"), "run-7", DECIDED_AT, SPEED,
    );

    expect(SPEED).toEqual({ delayMs: 250, kind: "PROCEED_WITHOUT_HUMAN" });
    expect(decided).toMatchObject({ delayMs: 0, ok: true });
  });

  it("forwards the kernel's refusal for an instant that does not parse", () => {
    expect(operatorReviewAuthority(
      humanReviewWitness("operator-1", "cmd-1"), "run-7", "not-an-instant", REQUIRE_HUMAN,
    )).toEqual({
      code: "APPROVAL_GRANT_MOMENT_INVALID", layer: "HUMAN_AUTHORITY_GATE", ok: false,
    });
  });

  it("forwards the kernel's refusal for a witness that names no principal", () => {
    expect(operatorReviewAuthority(
      humanReviewWitness("  ", "cmd-1"), "run-7", DECIDED_AT, REQUIRE_HUMAN,
    )).toEqual({ code: "APPROVAL_PRINCIPAL_UNNAMED", layer: "HUMAN_AUTHORITY_GATE", ok: false });
  });

  it("refuses an empty run reference instead of minting a grant bound to no work", () => {
    expect(operatorReviewAuthority(
      humanReviewWitness("operator-1", "cmd-1"), "", DECIDED_AT, REQUIRE_HUMAN,
    )).toEqual({
      code: "APPROVAL_AUTHORITY_BINDING_MISMATCH", layer: "HUMAN_AUTHORITY_GATE", ok: false,
    });
  });
});
