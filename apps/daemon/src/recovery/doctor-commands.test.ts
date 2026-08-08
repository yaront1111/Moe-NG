import { describe, expect, it } from "vitest";
import {
  evaluateDoctorCommandBytes,
  DOCTOR_COMMAND_KINDS,
  DOCTOR_RECOVERY_SCHEMA_VERSION,
} from "./doctor-commands.js";

/**
 * Doctor recovery commands REPORT and PROPOSE. None of them applies a repair.
 *
 * The kind list is asserted by SET EQUALITY against a hand-transcribed list so a
 * `doctor.apply_*` or `doctor.force_*` command cannot appear unnoticed, and a
 * second assertion pins the naming rule itself — every kind must be a report or
 * a proposal — so a repair command could not slip in under an innocuous name
 * either. This is the daemon-side half of "nothing silently resumes".
 */
const EXPECTED_KINDS = [
  "doctor.report_recovery_state",
  "doctor.propose_effect_reconciliation",
  "doctor.propose_resource_release",
  "doctor.propose_quarantine_export",
  "doctor.propose_resume",
] as const;

/** Each proposal names one operation the runtime command vocabulary declares. */
const PROPOSALS: ReadonlyArray<readonly [string, string]> = [
  ["doctor.propose_effect_reconciliation", "recovery.reconcile_external"],
  ["doctor.propose_resource_release", "resource.confirm_released"],
  ["doctor.propose_quarantine_export", "quarantine.export_forensic"],
  ["doctor.propose_resume", "work.resume"],
];

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: DOCTOR_RECOVERY_SCHEMA_VERSION,
    kind: "doctor.report_recovery_state",
    subjectRef: "intent-1",
    recordEpoch: 7,
    observedEpoch: 7,
    ...overrides,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function evaluate(overrides: Readonly<Record<string, unknown>> = {}): ReturnType<
  typeof evaluateDoctorCommandBytes
> {
  return evaluateDoctorCommandBytes(encode(request(overrides)));
}

describe("the doctor recovery command surface", () => {
  it("declares exactly the report and propose commands, by set equality", () => {
    expect([...DOCTOR_COMMAND_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it("declares no command that applies a repair", () => {
    for (const kind of DOCTOR_COMMAND_KINDS) {
      expect(kind.startsWith("doctor.report_") || kind.startsWith("doctor.propose_")).toBe(true);
    }
    expect(DOCTOR_COMMAND_KINDS.length).toBeGreaterThan(0);
  });

  it("pins the request schema version literal", () => {
    expect(DOCTOR_RECOVERY_SCHEMA_VERSION).toBe("moe-doctor-recovery-request/1");
  });
});

describe("doctor commands report and propose without applying", () => {
  it("reports recovery state without proposing a change", () => {
    const result = evaluate();
    expect(result.outcome).toBe("REPORTED");
    if (result.outcome !== "REPORTED") return;
    expect(result.subjectRef).toBe("intent-1");
    expect(result.appliesChange).toBe(false);
    expect(result).not.toHaveProperty("command");
  });

  it.each(PROPOSALS)("%s proposes %s for confirmation instead of applying it", (kind, command) => {
    const result = evaluate({ kind });
    expect(result.outcome).toBe("PROPOSED");
    if (result.outcome !== "PROPOSED") return;
    expect(result.command).toBe(command);
    expect(result.confirmationRequired).toBe(true);
    expect(result.appliesChange).toBe(false);
  });

  it("never applies a change on any declared command", () => {
    const outcomes = DOCTOR_COMMAND_KINDS.map((kind) => evaluate({ kind }));
    expect(outcomes).toHaveLength(EXPECTED_KINDS.length);
    expect(outcomes.length).toBeGreaterThan(0);
    for (const result of outcomes) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.appliesChange).toBe(false);
    }
  });

  it("requires confirmation on every proposal it can emit", () => {
    const proposals = DOCTOR_COMMAND_KINDS.map((kind) => evaluate({ kind })).filter(
      (result) => result.outcome === "PROPOSED",
    );
    expect(proposals).toHaveLength(PROPOSALS.length);
    for (const proposal of proposals) {
      if (proposal.outcome !== "PROPOSED") continue;
      expect(proposal.confirmationRequired).toBe(true);
    }
  });
});

describe("doctor command ingress refuses before it composes", () => {
  it("refuses a payload that is not bytes, at the decoder", () => {
    const result = evaluateDoctorCommandBytes({ kind: "doctor.report_recovery_state" });
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") return;
    expect(result.layer).toBe("BOUNDED_JSON");
    expect(result.error.code).toBe("JSON_INPUT_TYPE_INVALID");
  });

  it("refuses malformed JSON at the decoder", () => {
    const result = evaluateDoctorCommandBytes(new TextEncoder().encode("{"));
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") return;
    expect(result.layer).toBe("BOUNDED_JSON");
    expect(result.error.code).toBe("JSON_SYNTAX_INVALID");
  });

  it("refuses a request carrying an undeclared extra key", () => {
    const result = evaluate({ elapsedMs: 60_000 });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
    expect(result.layer).toBe("DOCTOR");
  });

  it("refuses a request missing a declared key", () => {
    const { observedEpoch: _dropped, ...partial } = request();
    const result = evaluateDoctorCommandBytes(encode(partial));
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
    expect(result.layer).toBe("DOCTOR");
  });

  it("refuses a request pinned to a different schema version", () => {
    const result = evaluate({ schemaVersion: "moe-doctor-recovery-request/2" });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
  });

  it("refuses a command kind the surface does not declare", () => {
    const result = evaluate({ kind: "doctor.apply_recovery" });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
    expect(result.layer).toBe("DOCTOR");
  });

  it("refuses an observed epoch that is not a safe non-negative integer", () => {
    const result = evaluate({ observedEpoch: -1 });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
  });

  /**
   * The record epoch and the subject reference get their own cases because each
   * shares a guard with a neighbour. A single fixture that broke both operands
   * at once would leave either operand free to be neutralised unnoticed.
   */
  it("refuses a record epoch that is not a safe integer", () => {
    const result = evaluate({ recordEpoch: 1.5 });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
  });

  it("refuses an empty subject reference", () => {
    const result = evaluate({ subjectRef: "" });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
  });
});

describe("doctor commands cannot act on stale authority", () => {
  it("refuses a command whose observed epoch is behind the durable record", () => {
    const result = evaluate({ kind: "doctor.propose_resume", observedEpoch: 6, recordEpoch: 7 });
    expect(result.outcome).toBe("AUTHORITY_STALE");
    if (result.outcome !== "AUTHORITY_STALE") return;
    expect(result.code).toBe("DOCTOR_AUTHORITY_STALE");
    expect(result.layer).toBe("DOCTOR");
  });

  it("refuses a stale report just as it refuses a stale proposal", () => {
    const result = evaluate({ observedEpoch: 6, recordEpoch: 7 });
    expect(result.outcome).toBe("AUTHORITY_STALE");
    if (result.outcome !== "AUTHORITY_STALE") return;
    expect(result.code).toBe("DOCTOR_AUTHORITY_STALE");
  });

  it("admits a command observed at the durable epoch", () => {
    expect(evaluate({ observedEpoch: 7, recordEpoch: 7 }).outcome).toBe("REPORTED");
  });

  it("admits a command observed beyond the durable epoch", () => {
    expect(evaluate({ observedEpoch: 8, recordEpoch: 7 }).outcome).toBe("REPORTED");
  });

  /**
   * Two layers can refuse one request. The test pins WHICH answered, so a shape
   * check that started passing malformed input through to the epoch comparison
   * would show up here rather than staying green on "it refused".
   */
  it("answers the shape refusal before the authority refusal", () => {
    const result = evaluate({ elapsedMs: 1, observedEpoch: 6, recordEpoch: 7 });
    expect(result.outcome).toBe("REQUEST_INVALID");
    if (result.outcome !== "REQUEST_INVALID") return;
    expect(result.code).toBe("DOCTOR_REQUEST_SHAPE_INVALID");
  });
});
