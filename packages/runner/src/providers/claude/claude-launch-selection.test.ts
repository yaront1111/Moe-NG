import { describe, expect, it } from "vitest";

import {
  CLAUDE_LAUNCH_SELECTION_CODES,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_LAUNCH_SELECTION_LAYER,
  CLAUDE_MODEL_EVIDENCE_KINDS,
  CLAUDE_REASONING_EFFORTS,
  snapshotLaunchSelection,
  verifyLaunchSelection,
  type ClaudeLaunchSelection,
} from "./claude-launch-selection.js";

const MODEL = "claude-opus-5-20260514";
const ALIAS = "claude-opus-5";
const EFFORT = "high";
const EVIDENCE = "claude-opus-5-20260514/build-2026-05-14";
const CONFIGURATION = "ab".repeat(32);
const POLICY = "cd".repeat(32);
const ORCHESTRATION = "ef".repeat(32);
const PROFILE = "profile-revision-19";
const RUNTIME_VERSION = "claude-cli/1.2.3";

const selection = (overrides: Partial<ClaudeLaunchSelection> = {}): ClaudeLaunchSelection => ({
  provider: "claude",
  selectedModelId: MODEL,
  modelSnapshotKind: "DATED_SNAPSHOT",
  modelSnapshotEvidence: EVIDENCE,
  reasoningEffort: EFFORT,
  profileRevisionId: PROFILE,
  configurationDigest: CONFIGURATION,
  policyDigest: POLICY,
  orchestrationDigest: ORCHESTRATION,
  concurrencyCeiling: 4,
  ...overrides,
});

const MODEL_FLAG = CLAUDE_LAUNCH_SELECTION_FLAGS.model;
const EFFORT_FLAG = CLAUDE_LAUNCH_SELECTION_FLAGS.effort;

const argvFor = (model: string = MODEL, effort: string = EFFORT): readonly string[] =>
  [MODEL_FLAG, model, EFFORT_FLAG, effort];

/** Every refusal is read through here so no arm can pass by throwing instead. */
function refusalOf(
  value: unknown, argv: unknown,
): { readonly code: string; readonly layer: string; readonly serialized: string } {
  const verdict = verifyLaunchSelection(value, argv);
  if (verdict.ok) throw new Error("expected a refusal, received an accepted selection");
  return { code: verdict.code, layer: verdict.layer, serialized: JSON.stringify(verdict) };
}

describe("Claude launch selection", () => {
  it("publishes closed vocabularies whose UNKNOWN member can never gain authority", () => {
    expect(CLAUDE_LAUNCH_SELECTION_LAYER).toBe("TELEMETRY_CONFIGURATION");
    expect(CLAUDE_MODEL_EVIDENCE_KINDS.length).toBe(3);
    expect(CLAUDE_MODEL_EVIDENCE_KINDS).toContain("UNKNOWN");
    expect(CLAUDE_REASONING_EFFORTS.length).toBe(6);
    expect(CLAUDE_REASONING_EFFORTS).toContain("UNKNOWN");
    expect(CLAUDE_LAUNCH_SELECTION_CODES.length).toBe(7);
    expect(Object.isFrozen(CLAUDE_MODEL_EVIDENCE_KINDS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_REASONING_EFFORTS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_SELECTION_CODES)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_SELECTION_FLAGS)).toBe(true);
  });

  it("keeps the model and effort refusal families disjoint so each drills alone", () => {
    const model = CLAUDE_LAUNCH_SELECTION_CODES.filter((code) => code.includes("_MODEL_"));
    const effort = CLAUDE_LAUNCH_SELECTION_CODES.filter((code) => code.includes("_EFFORT_"));
    expect(model.length).toBe(3);
    expect(effort.length).toBe(3);
    expect(model.filter((code) => (effort as readonly string[]).includes(code))).toEqual([]);
  });

  it("snapshots a valid selection into a frozen record the caller cannot reach back into", () => {
    const source = selection();
    const snapshot = snapshotLaunchSelection(source);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error("valid selection did not snapshot");
    expect(snapshot).toEqual(selection());
    expect(Object.isFrozen(snapshot)).toBe(true);
    (source as { selectedModelId: string }).selectedModelId = "claude-mutated-1";
    expect(snapshot.selectedModelId).toBe(MODEL);
  });

  it("preserves dated exact model evidence verbatim and keeps absence explicit", () => {
    const dated = snapshotLaunchSelection(selection());
    expect(dated?.modelSnapshotEvidence).toBe(EVIDENCE);
    expect(dated?.modelSnapshotKind).toBe("DATED_SNAPSHOT");
    const absent = snapshotLaunchSelection(
      selection({ modelSnapshotKind: "UNKNOWN", modelSnapshotEvidence: "UNKNOWN" }));
    expect(absent?.modelSnapshotEvidence).toBe("UNKNOWN");
    expect(absent?.modelSnapshotKind).toBe("UNKNOWN");
    // Absent evidence stays absent: it may not be dressed up as a value, and a
    // dated kind may not claim the absence literal.
    expect(snapshotLaunchSelection(
      selection({ modelSnapshotKind: "UNKNOWN", modelSnapshotEvidence: EVIDENCE }))).toBeNull();
    expect(snapshotLaunchSelection(
      selection({ modelSnapshotKind: "DATED_SNAPSHOT", modelSnapshotEvidence: "UNKNOWN" }))).toBeNull();
  });

  it("refuses every selection that is not an exact bounded plain record", () => {
    const accessor = { ...selection() } as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "selectedModelId", { enumerable: true, get: () => MODEL });
    const borrowed = Object.create({ ...selection() }) as Record<string, unknown>;
    borrowed["provider"] = "claude";
    const revocable = Proxy.revocable({ ...selection() }, {});
    revocable.revoke();
    const hostile = new Proxy({ ...selection() }, {
      getOwnPropertyDescriptor: () => { throw new Error("hostile reflection trap"); },
    });
    const cases: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["array", [selection()]],
      ["string", MODEL],
      ["extra-key", { ...selection(), extra: "value" }],
      ["missing-key", (() => { const { policyDigest: _drop, ...rest } = selection(); return rest; })()],
      ["accessor", accessor],
      ["prototype-borrowed", borrowed],
      ["revoked-proxy", revocable.proxy],
      ["descriptor-trap", hostile],
      ["provider", selection({ provider: "anthropic" as ClaudeLaunchSelection["provider"] })],
      ["model-empty", selection({ selectedModelId: "" })],
      ["model-space", selection({ selectedModelId: "claude opus 5" })],
      ["model-tab", selection({ selectedModelId: `claude\topus` })],
      ["model-not-string", selection({ selectedModelId: 5 as unknown as string })],
      ["evidence-kind", selection({
        modelSnapshotKind: "GUESSED" as ClaudeLaunchSelection["modelSnapshotKind"] })],
      ["effort-member", selection({
        reasoningEffort: "extreme" as ClaudeLaunchSelection["reasoningEffort"] })],
      ["profile-empty", selection({ profileRevisionId: "" })],
      ["configuration-digest", selection({ configurationDigest: "not-hex" })],
      ["policy-digest", selection({ policyDigest: CONFIGURATION.slice(0, 63) })],
      ["orchestration-digest", selection({ orchestrationDigest: ORCHESTRATION.toUpperCase() })],
      ["ceiling-zero", selection({ concurrencyCeiling: 0 })],
      ["ceiling-negative", selection({ concurrencyCeiling: -1 })],
      ["ceiling-fractional", selection({ concurrencyCeiling: 1.5 })],
      ["ceiling-not-number", selection({ concurrencyCeiling: "4" as unknown as number })],
    ];
    expect(cases.length).toBe(24);
    let ran = 0;
    for (const [name, value] of cases) {
      expect({ name, snapshot: snapshotLaunchSelection(value) }).toEqual({ name, snapshot: null });
      expect({ name, code: refusalOf(value, argvFor()).code })
        .toEqual({ name, code: "CLAUDE_LAUNCH_SELECTION_MALFORMED" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses argv that is not bounded plain string data before it reads a flag", () => {
    const hostileArgv = [MODEL_FLAG, MODEL];
    Object.defineProperty(hostileArgv, Symbol.iterator, { value: function* () { yield MODEL; } });
    const cases: readonly (readonly [string, unknown])[] = [
      ["not-array", { 0: MODEL_FLAG, length: 1 }],
      ["null", null],
      ["non-string-element", [MODEL_FLAG, 5]],
      ["iterator-trap", hostileArgv],
      ["holes", Object.assign([MODEL_FLAG], { length: 4 })],
    ];
    expect(cases.length).toBe(5);
    let ran = 0;
    for (const [name, argv] of cases) {
      expect({ name, code: refusalOf(selection(), argv).code })
        .toEqual({ name, code: "CLAUDE_LAUNCH_SELECTION_MALFORMED" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("accepts argv carrying exactly one exact model and one exact effort", () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ["separate", argvFor()],
      ["joined", [`${MODEL_FLAG}=${MODEL}`, `${EFFORT_FLAG}=${EFFORT}`]],
      ["mixed", [`${MODEL_FLAG}=${MODEL}`, "--print", EFFORT_FLAG, EFFORT]],
      ["surrounded", ["--print", MODEL_FLAG, MODEL, "prompt", EFFORT_FLAG, EFFORT, "trailing"]],
    ];
    expect(cases.length).toBe(4);
    let ran = 0;
    for (const [name, argv] of cases) {
      const verdict = verifyLaunchSelection(selection(), argv);
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: true });
      if (!verdict.ok) throw new Error(`${name} was refused`);
      expect(verdict.selection.selectedModelId).toBe(MODEL);
      expect(verdict.selection.reasoningEffort).toBe(EFFORT);
      expect(Object.isFrozen(verdict.selection)).toBe(true);
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses the model arm with its own three codes", () => {
    const cases: readonly (readonly [string, readonly string[], string])[] = [
      ["absent", [EFFORT_FLAG, EFFORT], "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["valueless-trailing", [EFFORT_FLAG, EFFORT, MODEL_FLAG], "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["valueless-joined", [`${MODEL_FLAG}=`, EFFORT_FLAG, EFFORT], "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["duplicate-agreeing", [MODEL_FLAG, MODEL, MODEL_FLAG, MODEL, EFFORT_FLAG, EFFORT],
        "CLAUDE_LAUNCH_MODEL_AMBIGUOUS"],
      ["duplicate-conflicting", [MODEL_FLAG, MODEL, MODEL_FLAG, ALIAS, EFFORT_FLAG, EFFORT],
        "CLAUDE_LAUNCH_MODEL_AMBIGUOUS"],
      ["duplicate-mixed-spelling", [`${MODEL_FLAG}=${MODEL}`, MODEL_FLAG, MODEL, EFFORT_FLAG, EFFORT],
        "CLAUDE_LAUNCH_MODEL_AMBIGUOUS"],
      ["alias-only", argvFor(ALIAS), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["other-dated-model", argvFor("claude-opus-5-20260515"), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["case-drift", argvFor(MODEL.toUpperCase()), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
    ];
    expect(cases.length).toBe(9);
    let ran = 0;
    for (const [name, argv, code] of cases) {
      const refusal = refusalOf(selection(), argv);
      expect({ name, code: refusal.code, layer: refusal.layer })
        .toEqual({ name, code, layer: "TELEMETRY_CONFIGURATION" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses the effort arm with three codes disjoint from the model arm's", () => {
    const cases: readonly (readonly [string, ClaudeLaunchSelection, readonly string[], string])[] = [
      ["absent", selection(), [MODEL_FLAG, MODEL], "CLAUDE_LAUNCH_EFFORT_UNPROVEN"],
      ["valueless-trailing", selection(), [MODEL_FLAG, MODEL, EFFORT_FLAG],
        "CLAUDE_LAUNCH_EFFORT_UNPROVEN"],
      ["valueless-joined", selection(), [MODEL_FLAG, MODEL, `${EFFORT_FLAG}=`],
        "CLAUDE_LAUNCH_EFFORT_UNPROVEN"],
      // UNKNOWN never gains authority: argv that literally spells it still proves nothing.
      ["unknown-selected", selection({ reasoningEffort: "UNKNOWN" }), argvFor(MODEL, "UNKNOWN"),
        "CLAUDE_LAUNCH_EFFORT_UNPROVEN"],
      ["duplicate-agreeing", selection(),
        [MODEL_FLAG, MODEL, EFFORT_FLAG, EFFORT, EFFORT_FLAG, EFFORT],
        "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS"],
      ["duplicate-conflicting", selection(),
        [MODEL_FLAG, MODEL, EFFORT_FLAG, EFFORT, EFFORT_FLAG, "low"],
        "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS"],
      ["other-effort", selection(), argvFor(MODEL, "low"), "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
      ["case-drift", selection(), argvFor(MODEL, EFFORT.toUpperCase()),
        "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
    ];
    expect(cases.length).toBe(8);
    let ran = 0;
    for (const [name, value, argv, code] of cases) {
      const refusal = refusalOf(value, argv);
      expect({ name, code: refusal.code, layer: refusal.layer })
        .toEqual({ name, code, layer: "TELEMETRY_CONFIGURATION" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("checks the model arm before the effort arm so neither answers for the other", () => {
    expect(refusalOf(selection(), []).code).toBe("CLAUDE_LAUNCH_MODEL_UNPROVEN");
    expect(refusalOf(selection(), argvFor(ALIAS, "low")).code).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
  });

  it("never lets a profile revision or a runtime version stand in for model or effort", () => {
    const cases: readonly (readonly [string, readonly string[], string])[] = [
      ["profile-revision-alone", [PROFILE, RUNTIME_VERSION], "CLAUDE_LAUNCH_MODEL_UNPROVEN"],
      ["profile-revision-as-model", argvFor(PROFILE), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["runtime-version-as-model", argvFor(RUNTIME_VERSION), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
      ["profile-revision-as-effort", argvFor(MODEL, PROFILE), "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
      ["runtime-version-as-effort", argvFor(MODEL, RUNTIME_VERSION), "CLAUDE_LAUNCH_EFFORT_MISMATCH"],
      // Evidence is not authority: a snapshot value in argv does not name the model.
      ["evidence-as-model", argvFor(EVIDENCE), "CLAUDE_LAUNCH_MODEL_MISMATCH"],
    ];
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const [name, argv, code] of cases) {
      expect({ name, code: refusalOf(selection(), argv).code }).toEqual({ name, code });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("verifies an UNKNOWN-evidence selection on argv alone, never on the evidence", () => {
    const absent = selection({ modelSnapshotKind: "UNKNOWN", modelSnapshotEvidence: "UNKNOWN" });
    const verdict = verifyLaunchSelection(absent, argvFor());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("UNKNOWN evidence must not block a model argv proves");
    expect(verdict.selection.modelSnapshotEvidence).toBe("UNKNOWN");
    expect(refusalOf(absent, [EFFORT_FLAG, EFFORT]).code).toBe("CLAUDE_LAUNCH_MODEL_UNPROVEN");
  });

  it("echoes no argv element, model id, effort or digest in any field of a refusal", () => {
    // `EFFORT` and the drifted effort are in here deliberately: they are short
    // common words, so a message that reaches for "allowed"/"below" would leak
    // one. Static per-code messages are what keep this honest.
    const secrets: readonly string[] = [
      MODEL, ALIAS, EVIDENCE, PROFILE, CONFIGURATION, POLICY, ORCHESTRATION, RUNTIME_VERSION,
      EFFORT, "low",
    ];
    expect(secrets).toHaveLength(10);
    const refusals: readonly string[] = [
      refusalOf(selection(), [EFFORT_FLAG, EFFORT]).serialized,
      refusalOf(selection(), argvFor(ALIAS)).serialized,
      refusalOf(selection(), [MODEL_FLAG, MODEL, MODEL_FLAG, ALIAS, EFFORT_FLAG, EFFORT]).serialized,
      refusalOf(selection(), [MODEL_FLAG, MODEL]).serialized,
      refusalOf(selection(), argvFor(MODEL, "low")).serialized,
      refusalOf(selection(), [MODEL_FLAG, MODEL, EFFORT_FLAG, EFFORT, EFFORT_FLAG, "low"]).serialized,
      refusalOf({ ...selection(), extra: "value" }, argvFor()).serialized,
      refusalOf(selection(), [RUNTIME_VERSION, PROFILE]).serialized,
    ];
    expect(refusals).toHaveLength(8);
    let ran = 0;
    for (const serialized of refusals) {
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(0);
        expect(serialized).not.toContain(secret);
      }
      // The flag spellings are argv elements too and must not leak either.
      expect(serialized).not.toContain(MODEL_FLAG);
      expect(serialized).not.toContain(EFFORT_FLAG);
      ran += 1;
    }
    expect(ran).toBe(refusals.length);
  });

  it("never throws and never rejects, whatever it is handed", () => {
    const cases: readonly (readonly [string, unknown, unknown])[] = [
      ["both-null", null, null],
      ["both-undefined", undefined, undefined],
      ["symbol-argv", selection(), Symbol("argv")],
      ["function-selection", () => selection(), argvFor()],
      ["bigint", 1n, 2n],
    ];
    expect(cases.length).toBe(5);
    let ran = 0;
    for (const [name, value, argv] of cases) {
      const verdict = verifyLaunchSelection(value, argv);
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: false });
      if (verdict.ok) throw new Error(`${name} was accepted`);
      expect(verdict.code).toBe("CLAUDE_LAUNCH_SELECTION_MALFORMED");
      expect(verdict.layer).toBe("TELEMETRY_CONFIGURATION");
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });
});
