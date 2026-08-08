import { describe, expect, it } from "vitest";
import { makeIntent, makeProof, makeTombstone } from "../supervisor/effect-test-fixtures.js";
import { classifyCrash } from "./crash-classification.js";
import { RECOVERY_OUTCOME_KINDS } from "./recovery-contract.js";
import {
  observation,
  records,
  situation,
  ADVANCED,
  HELD_EPOCH,
} from "./recovery-test-fixtures.js";

/**
 * DoD 3, the security-shaped clause: "quiet presence alone cannot steal
 * ownership and late observations cannot advance stale authority", plus the
 * rule that keeps a suspect effect out of both — an effect nobody could
 * establish is never optimistically adopted and never auto-resumed.
 *
 * Every negative arm pins the specific code AND the layer that refused.
 */
function kindOf(input: unknown): string {
  const outcome = classifyCrash(input) as { kind?: string };
  return String(outcome.kind);
}

const TOMBSTONED_RECORDS = {
  intent: makeIntent({ state: "ARMED" }),
  attempt: null,
  attemptState: "ABSENT",
  grant: null,
  tombstone: makeTombstone(),
  registration: null,
  lockState: "RELEASED",
  resourceFact: "PROVEN_RELEASED",
} as const;

describe("quiet presence cannot steal ownership", () => {
  it("refuses to adopt a live-looking process with no authority at all", () => {
    const outcome = classifyCrash(
      situation({ observation: observation({ presenceLooksLive: true }) }),
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
    expect(outcome.failure.layer).toBe("CLASSIFICATION");
  });

  it("refuses to adopt on an authority whose epoch never advanced", () => {
    const outcome = classifyCrash(
      situation({
        claimedAuthority: makeProof({ leaseToken: "token-secret-2" }),
        observation: observation({ presenceLooksLive: true }),
      }),
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
    expect(outcome.failure.layer).toBe("CLASSIFICATION");
  });

  it("refuses to adopt on a replayed token even at an advanced epoch", () => {
    const outcome = classifyCrash(
      situation({ claimedAuthority: makeProof({ epoch: HELD_EPOCH + 1 }) }),
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN");
  });

  it("adopts only once the fence really advanced", () => {
    expect(kindOf(situation({ claimedAuthority: ADVANCED }))).toBe("ADOPTED");
  });
});

describe("late observations cannot advance stale authority", () => {
  it("refuses an observation carrying an older epoch than the durable record", () => {
    const outcome = classifyCrash(
      situation({
        claimedAuthority: ADVANCED,
        observation: observation({ observedEpoch: HELD_EPOCH - 1 }),
      }),
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_STALE_OBSERVATION_REFUSED");
    expect(outcome.failure.layer).toBe("CLASSIFICATION");
  });

  /**
   * Refused is not the same as dropped. A classifier that ignored the stale
   * observation and answered from the records alone would satisfy a weaker
   * assertion while losing the refusal the DoD asks for, so the outcome kind is
   * asserted to be outside the ordinary vocabulary entirely.
   */
  it("does not silently drop the stale observation into an ordinary outcome", () => {
    const stale = classifyCrash(
      situation({
        claimedAuthority: ADVANCED,
        observation: observation({ observedEpoch: HELD_EPOCH - 1 }),
      }),
    );
    expect([...RECOVERY_OUTCOME_KINDS]).not.toContain(stale.kind);
  });

  it("accepts an observation at the durable epoch", () => {
    expect(kindOf(situation({ claimedAuthority: ADVANCED }))).toBe("ADOPTED");
  });

  it("refuses a malformed crash situation", () => {
    const outcome = classifyCrash({ records: records(), observation: observation() });
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OBSERVATION_MALFORMED");
    expect(outcome.failure.layer).toBe("CLASSIFICATION");
  });

  it("refuses an observation naming an effect status the vocabulary does not declare", () => {
    const outcome = classifyCrash(
      situation({ observation: observation({ effectStatus: "PROBABLY_GONE" }) }),
    );
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OBSERVATION_MALFORMED");
  });

  it("refuses a durable record set that does not parse", () => {
    const outcome = classifyCrash(situation({ records: { intent: null } }));
    expect(outcome.kind).toBe("REFUSED");
    if (outcome.kind !== "REFUSED") return;
    expect(outcome.failure.code).toBe("RECOVERY_OBSERVATION_MALFORMED");
  });
});

describe("suspect effects are never optimistically adopted", () => {
  it("keeps an unestablished effect suspect even under a fully advanced fence", () => {
    const outcome = classifyCrash(
      situation({
        claimedAuthority: ADVANCED,
        observation: observation({ effectStatus: "UNESTABLISHED", presenceLooksLive: true }),
      }),
    );
    expect(outcome.kind).toBe("SUSPECT");
    if (outcome.kind !== "SUSPECT") return;
    expect(outcome.effectRef).toBe("intent-1");
  });

  it("makes tombstoned records with an unestablished effect suspect, not absent", () => {
    const outcome = classifyCrash(
      situation({
        records: records(TOMBSTONED_RECORDS),
        observation: observation({
          processExit: { kind: "EXITED", code: 0 },
          effectStatus: "UNESTABLISHED",
        }),
      }),
    );
    expect(outcome.kind).toBe("SUSPECT");
  });

  it("reaches ABSENT for the same records once the effect is proven absent", () => {
    const outcome = classifyCrash(
      situation({
        records: records(TOMBSTONED_RECORDS),
        observation: observation({
          processExit: { kind: "EXITED", code: 0 },
          effectStatus: "PROVEN_ABSENT",
        }),
      }),
    );
    expect(outcome.kind).toBe("ABSENT");
  });
});
