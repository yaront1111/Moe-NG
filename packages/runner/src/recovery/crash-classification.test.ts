import { describe, expect, it } from "vitest";
import { classifyCrash } from "./crash-classification.js";
import { RECOVERY_OUTCOME_KINDS } from "./recovery-contract.js";
import {
  observation,
  records,
  situation,
  ADVANCED,
  COMMIT,
  HELD_EPOCH,
  HELD_TOKEN,
  SETTLED,
} from "./recovery-test-fixtures.js";

/**
 * DoD 2 is a SET property: "every injected crash yields adopted, absent,
 * suspect, quarantined, or an exact reconciliation command; nothing silently
 * resumes". The sweep asserts the observed kinds EQUAL the closed vocabulary —
 * a sixth kind and a missing kind both fail — and records per-kind counts so a
 * classifier that collapses onto one kind is visible rather than passing.
 *
 * Hand-transcribed rather than read from the subject: an expectation derived
 * from the vocabulary under test moves with it, so a dropped member would agree
 * with itself and never redden.
 */
const EXPECTED_KINDS = [
  "ADOPTED",
  "ABSENT",
  "SUSPECT",
  "QUARANTINED",
  "RECONCILIATION_COMMAND",
] as const;

/**
 * Hand-written expectations, one per injected crash. Not derived from the
 * classifier: a table generated from the function under test would still agree
 * with itself after the function started answering something else.
 */
const CRASHES: ReadonlyArray<readonly [string, unknown, string]> = [
  [
    "a live run whose records identify it, adopted under an advanced fence",
    situation({ claimedAuthority: ADVANCED }),
    "ADOPTED",
  ],
  [
    "a settled terminal whose process exited cleanly and released everything",
    situation({
      records: records(SETTLED),
      observation: observation({
        processExit: { kind: "EXITED", code: 0 },
        effectStatus: "PROVEN_ABSENT",
      }),
    }),
    "ABSENT",
  ],
  [
    "a settled terminal whose process was signalled and released everything",
    situation({
      records: records(SETTLED),
      observation: observation({
        processExit: { kind: "SIGNALLED", signal: "SIGKILL" },
        effectStatus: "PROVEN_ABSENT",
      }),
    }),
    "ABSENT",
  ],
  [
    "a registered lock whose state could not be read",
    situation({ records: records({ lockState: "UNKNOWN" }) }),
    "SUSPECT",
  ],
  [
    "an effect whose status nobody could establish",
    situation({
      claimedAuthority: ADVANCED,
      observation: observation({ effectStatus: "UNESTABLISHED" }),
    }),
    "SUSPECT",
  ],
  [
    "an unestablished effect over an exited process is still never adopted",
    situation({
      claimedAuthority: ADVANCED,
      observation: observation({
        processExit: { kind: "EXITED", code: 3 },
        effectStatus: "UNESTABLISHED",
      }),
    }),
    "SUSPECT",
  ],
  [
    "a draining attempt still holding an unverifiable resource",
    situation({
      records: records({ attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
      observation: observation({
        processExit: { kind: "EXITED", code: 1 },
        effectStatus: "PROVEN_ABSENT",
      }),
    }),
    "QUARANTINED",
  ],
  [
    "a settled terminal whose external effect is still proven running",
    situation({
      records: records(SETTLED),
      observation: observation({
        processExit: { kind: "EXITED", code: 0 },
        effectStatus: "PROVEN_ACTIVE",
      }),
    }),
    "QUARANTINED",
  ],
  [
    "records that were not written together, which no local decision can settle",
    situation({ records: records({ attemptState: "DRAINING" }) }),
    "RECONCILIATION_COMMAND",
  ],
  [
    "a released terminal whose process death was never observed",
    situation({
      records: records(SETTLED),
      observation: observation({ effectStatus: "PROVEN_ABSENT" }),
    }),
    "RECONCILIATION_COMMAND",
  ],
  [
    "a terminal attempt over a still-nonterminal effect with nothing left held",
    situation({
      records: records({
        attempt: null,
        attemptState: "TERMINAL",
        registration: null,
        lockState: "RELEASED",
        resourceFact: "PROVEN_RELEASED",
      }),
      observation: observation({
        processExit: { kind: "EXITED", code: 0 },
        effectStatus: "PROVEN_ABSENT",
      }),
    }),
    "RECONCILIATION_COMMAND",
  ],
];

function kindOf(input: unknown): string {
  const outcome = classifyCrash(input) as { kind?: string };
  return String(outcome.kind);
}

describe("the fixture lease this suite reasons about", () => {
  it("holds the epoch and token the stale-observation cases are measured against", () => {
    expect(COMMIT.intent.leaseBinding.epoch).toBe(HELD_EPOCH);
    expect(COMMIT.intent.leaseBinding.leaseToken).toBe(HELD_TOKEN);
  });
});

describe("every injected crash lands in the closed recovery vocabulary", () => {
  it("injects a non-zero, uniquely labelled set of crash situations", () => {
    expect(CRASHES.length).toBeGreaterThan(0);
    expect(CRASHES.length).toBe(11);
    expect(new Set(CRASHES.map(([label]) => label)).size).toBe(CRASHES.length);
  });

  it.each(CRASHES)("%s classifies to its one legal outcome", (_label, input, expected) => {
    expect(kindOf(input)).toBe(expected);
  });

  it("produces every declared outcome kind and no other", () => {
    const observed = new Set(CRASHES.map(([, input]) => kindOf(input)));
    expect([...observed].sort()).toEqual([...EXPECTED_KINDS].sort());
    expect([...RECOVERY_OUTCOME_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it("records a non-zero count for each outcome kind rather than leaning on one", () => {
    const counts: Record<string, number> = {};
    for (const [, input] of CRASHES) {
      const kind = kindOf(input);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts).toEqual({
      ADOPTED: 1,
      ABSENT: 2,
      SUSPECT: 3,
      QUARANTINED: 2,
      RECONCILIATION_COMMAND: 3,
    });
    for (const kind of EXPECTED_KINDS) {
      expect(counts[kind] ?? 0).toBeGreaterThan(0);
    }
  });

  it("offers no resume arm for any input to reach", () => {
    expect([...RECOVERY_OUTCOME_KINDS]).not.toContain("RESUMED");
    for (const [, input] of CRASHES) {
      const outcome = classifyCrash(input);
      expect(outcome.kind).not.toBe("RESUMED");
      expect(outcome).not.toHaveProperty("resumed");
    }
  });

  it("names the exact reconciliation command instead of guessing a repair", () => {
    const outcome = classifyCrash(situation({ records: records({ attemptState: "DRAINING" }) }));
    expect(outcome.kind).toBe("RECONCILIATION_COMMAND");
    if (outcome.kind !== "RECONCILIATION_COMMAND") return;
    expect(outcome.command).toBe("recovery.inspect_external");
  });

  it("names what remains held when it quarantines", () => {
    const outcome = classifyCrash(
      situation({
        records: records({ attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
        observation: observation({
          processExit: { kind: "EXITED", code: 1 },
          effectStatus: "PROVEN_ACTIVE",
        }),
      }),
    );
    expect(outcome.kind).toBe("QUARANTINED");
    if (outcome.kind !== "QUARANTINED") return;
    expect([...outcome.held]).toEqual(["resource:UNKNOWN", "effect:intent-1"]);
  });
});
