import { describe, expect, it } from "vitest";

import {
  ALLOWED_ENVIRONMENT_KEYS,
  PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS,
} from "../../platform/windows/windows-launch-request.js";
import {
  CLAUDE_LAUNCH_SELECTION_CODES,
  CLAUDE_LAUNCH_SELECTION_ENV,
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_LAUNCH_SELECTION_LAYER,
  CLAUDE_MODEL_EVIDENCE_KINDS,
  CLAUDE_REASONING_EFFORTS,
  snapshotLaunchSelection,
  type ClaudeLaunchSelection,
} from "./claude-launch-selection.js";
import { verifyLaunchSelection } from "./claude-launch-verify.js";

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
/** An environment that names neither half, so an env case has to opt in. */
const NO_ENV: Readonly<Record<string, string>> = Object.freeze({ SYSTEMROOT: "C:\\Windows" });

const argvFor = (model: string = MODEL, effort: string = EFFORT): readonly string[] =>
  [MODEL_FLAG, model, EFFORT_FLAG, effort];

/**
 * Every refusal is read through here so no arm can pass by throwing instead.
 * The environment arrives as a REST parameter rather than a defaulted one: a
 * default would swallow an explicitly-passed `undefined` and quietly test the
 * benign environment instead of the hostile one the case named.
 */
function refusalOf(
  value: unknown, argv: unknown, ...rest: readonly unknown[]
): { readonly code: string; readonly layer: string; readonly serialized: string } {
  const environment = rest.length === 0 ? NO_ENV : rest[0];
  const verdict = verifyLaunchSelection(value, argv, environment);
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
    expect(CLAUDE_LAUNCH_SELECTION_CODES.length).toBe(8);
    expect(CLAUDE_LAUNCH_SELECTION_CODES).toContain("CLAUDE_LAUNCH_SESSION_RESUMED");
    expect(Object.isFrozen(CLAUDE_MODEL_EVIDENCE_KINDS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_REASONING_EFFORTS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_SELECTION_CODES)).toBe(true);
    expect(Object.isFrozen(CLAUDE_LAUNCH_SELECTION_FLAGS)).toBe(true);
  });

  it("refuses every resume-family argv the installed CLI accepts, and only those", () => {
    // Spellings transcribed BY HAND from `claude --help` on the installed
    // binary, not derived from the production constant — a table built out of
    // the thing under test cannot discover that the thing under test is wrong.
    const resuming: readonly (readonly string[])[] = [
      ["--resume", "session-1", ...argvFor()],
      ["-r", "session-1", ...argvFor()],
      ["--resume=session-1", ...argvFor()],
      ["--resume", ...argvFor()],
      ["--continue", ...argvFor()],
      ["-c", ...argvFor()],
      ["--from-pr", "4207", ...argvFor()],
      ["--from-pr=4207", ...argvFor()],
      ["--cloud", "session-1", ...argvFor()],
      [...argvFor(), "--continue"],
    ];
    expect(resuming.length).toBe(10);
    let refused = 0;
    for (const argv of resuming) {
      const answer = refusalOf(selection(), argv);
      expect({ argv: argv[0], code: answer.code, layer: answer.layer })
        .toEqual({ argv: argv[0], code: "CLAUDE_LAUNCH_SESSION_RESUMED",
          layer: "TELEMETRY_CONFIGURATION" });
      expect(answer.serialized).not.toContain("session-1");
      expect(answer.serialized).not.toContain("4207");
      refused += 1;
    }
    expect(refused).toBe(resuming.length);
    // PRECEDENCE, not just presence. Each of these argv ALSO fails an arm on its
    // own — a drifted model, a duplicated effort, no model at all — so if the
    // resume guard were moved below the arms every one would answer with an arm
    // code instead. Without this the guard's POSITION is untested and a
    // reordering mutant survives every case above.
    const alsoBroken: readonly { readonly name: string; readonly argv: readonly string[] }[] = [
      { name: "resume+model-drift", argv: ["--resume", "s", ...argvFor(ALIAS)] },
      { name: "resume+effort-drift", argv: ["--continue", ...argvFor(MODEL, "low")] },
      { name: "resume+model-absent", argv: ["-r", "s", EFFORT_FLAG, EFFORT] },
      { name: "resume+effort-duplicate",
        argv: ["--continue", ...argvFor(), EFFORT_FLAG, "low"] },
    ];
    expect(alsoBroken.length).toBe(4);
    let precedence = 0;
    for (const item of alsoBroken) {
      expect({ name: item.name, code: refusalOf(selection(), item.argv).code })
        .toEqual({ name: item.name, code: "CLAUDE_LAUNCH_SESSION_RESUMED" });
      precedence += 1;
    }
    expect(precedence).toBe(alsoBroken.length);
    // The negative half. `--fork-session` only works WITH a resume flag, so on
    // its own it starts a fresh session the `--model` applies to; and a value
    // that merely CONTAINS a resume spelling is not that flag. Without these a
    // guard that refuses every argv would pass the ten cases above.
    const accepted: readonly (readonly string[])[] = [
      [...argvFor()],
      ["--print", ...argvFor()],
      ["--fork-session", ...argvFor()],
      [...argvFor(), "--append-system-prompt", "please --resume the review"],
      ["--model", MODEL, "--effort", EFFORT, "--name", "continue-the-work"],
    ];
    expect(accepted.length).toBe(5);
    let allowed = 0;
    for (const argv of accepted) {
      const verdict = verifyLaunchSelection(selection(), argv, NO_ENV);
      expect({ argv: argv.join(" "), ok: verdict.ok })
        .toEqual({ argv: argv.join(" "), ok: true });
      allowed += 1;
    }
    expect(allowed).toBe(accepted.length);
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
      const verdict = verifyLaunchSelection(selection(), argv, NO_ENV);
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
    const verdict = verifyLaunchSelection(absent, argvFor(), NO_ENV);
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

  it("spells the provider's own flags and override variables, hand-written here", () => {
    // HAND-SPELLED, never derived from the production constant: a test that read
    // the constant back could not discover the constant itself was invented.
    // Measured against the installed provider: claude --help exits 0 and lists
    // --model <model> and --effort <level>, and there is no --reasoning-effort.
    // The override variable names come from the installed binary's own strings,
    // where CLAUDE_CODE_EFFORT_LEVEL= is documented as overriding effort for the
    // session and ANTHROPIC_MODEL names the model.
    expect(CLAUDE_LAUNCH_SELECTION_FLAGS).toEqual({ model: "--model", effort: "--effort" });
    expect(CLAUDE_LAUNCH_SELECTION_ENV)
      .toEqual({ model: "ANTHROPIC_MODEL", effort: "CLAUDE_CODE_EFFORT_LEVEL" });
    expect(Object.isFrozen(CLAUDE_LAUNCH_SELECTION_ENV)).toBe(true);
  });

  it("the Windows provider boundary admits every override variable this provider spells, and no other selection key", () => {
    // BIDIRECTIONAL. The boundary roster is hand-spelled in the platform module
    // (which must never import providers/**), so nothing but this arm stops the
    // two spellings drifting apart. Set-equality both ways: an override the
    // provider adds and the boundary does not admit dies at ENCODE, and a name
    // the boundary admits that this provider does not spell is an unreviewed
    // widening wearing a launch-selection label.
    const spelled = Object.values(CLAUDE_LAUNCH_SELECTION_ENV);
    expect(spelled.length).toBeGreaterThan(0);
    expect([...PROVIDER_LAUNCH_SELECTION_ENVIRONMENT_KEYS].sort()).toEqual([...spelled].sort());
    for (const name of spelled) {
      expect({ name, admitted: ALLOWED_ENVIRONMENT_KEYS.includes(name) }).toEqual({
        name,
        admitted: true,
      });
    }
  });

  it("proves a hand-spelled provider-correct argv and refuses the invented spelling", () => {
    const real = verifyLaunchSelection(selection(), ["--model", MODEL, "--effort", EFFORT], NO_ENV);
    expect(real.ok).toBe(true);
    // The spelling this gate used to freeze. It is not a provider flag, so argv
    // carrying it names no effort at all — the launch would run at whatever the
    // provider defaulted to while this record claimed otherwise.
    expect(refusalOf(selection(), ["--model", MODEL, "--reasoning-effort", EFFORT]).code)
      .toBe("CLAUDE_LAUNCH_EFFORT_UNPROVEN");
  });

  it("refuses a proxy before any trap of it can run, on either operand", () => {
    let selectionTraps = 0;
    let argvTraps = 0;
    let environmentTraps = 0;
    const count = (counter: () => void): ProxyHandler<object> => ({
      ownKeys(target: object): ArrayLike<string | symbol> {
        counter();
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
        counter();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const proxiedSelection = new Proxy({ ...selection() }, count(() => { selectionTraps += 1; }));
    const proxiedArgv = new Proxy([...argvFor()], count(() => { argvTraps += 1; }));
    const proxiedEnvironment = new Proxy({ ...NO_ENV }, count(() => { environmentTraps += 1; }));
    const cases: readonly (readonly [string, unknown, unknown, unknown])[] = [
      ["selection", proxiedSelection, argvFor(), NO_ENV],
      ["argv", selection(), proxiedArgv, NO_ENV],
      ["environment", selection(), argvFor(), proxiedEnvironment],
      // A transparent proxy is refused for the same reason a trapping one is:
      // the gate cannot tell them apart without reflecting, and reflecting is
      // what runs the trap.
      ["transparent-selection", new Proxy({ ...selection() }, {}), argvFor(), NO_ENV],
      ["transparent-argv", selection(), new Proxy([...argvFor()], {}), NO_ENV],
      ["transparent-environment", selection(), argvFor(), new Proxy({ ...NO_ENV }, {})],
    ];
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const [name, value, argv, environment] of cases) {
      const refusal = refusalOf(value, argv, environment);
      expect({ name, code: refusal.code, layer: refusal.layer }).toEqual({
        name, code: "CLAUDE_LAUNCH_SELECTION_MALFORMED", layer: "TELEMETRY_CONFIGURATION" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
    expect({ selectionTraps, argvTraps, environmentTraps })
      .toEqual({ selectionTraps: 0, argvTraps: 0, environmentTraps: 0 });
    expect(snapshotLaunchSelection(proxiedSelection)).toBeNull();
    expect(selectionTraps).toBe(0);
  });

  it("never coerces a hostile field, so the caller's code cannot run inside the guard", () => {
    let coercions = 0;
    const hostileModel = {
      toString: (): string => { coercions += 1; throw new Error("coercion escaped the guard"); },
    };
    const value = { ...selection(), selectedModelId: hostileModel as unknown as string };
    // The bare snapshot is TOTAL: it answers null rather than throwing, so a
    // caller that uses it without the verifier around it is defended too.
    expect(snapshotLaunchSelection(value)).toBeNull();
    expect(refusalOf(value, argvFor()).code).toBe("CLAUDE_LAUNCH_SELECTION_MALFORMED");
    expect(coercions).toBe(0);
  });

  // The two environment arms live in SEPARATE tests, mirroring the two argv
  // arms. A single mixed table would redden under either mutation drill and so
  // could not show that the model and effort comparisons are independent.
  it("refuses an environment that overrides the effort argv proved", () => {
    // CLAUDE_CODE_EFFORT_LEVEL overrides the effort flag for the session, so a
    // conflicting value means the launched effort is not the claimed one.
    const cases: readonly (readonly [string, Record<string, string>])[] = [
      ["low", { ...NO_ENV, CLAUDE_CODE_EFFORT_LEVEL: "low" }],
      ["case-drift", { ...NO_ENV, CLAUDE_CODE_EFFORT_LEVEL: EFFORT.toUpperCase() }],
      ["empty", { ...NO_ENV, CLAUDE_CODE_EFFORT_LEVEL: "" }],
      ["not-a-member", { ...NO_ENV, CLAUDE_CODE_EFFORT_LEVEL: "extreme" }],
      // Windows environment variable names are CASE-INSENSITIVE and this
      // launcher is win32-only, so this spelling reaches the child as the same
      // override. A case-sensitive gate would be bypassed by one keystroke.
      ["case-variant-name", { ...NO_ENV, Claude_Code_Effort_Level: "low" }],
      ["lowercase-name", { ...NO_ENV, claude_code_effort_level: "low" }],
    ];
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const [name, environment] of cases) {
      const refusal = refusalOf(selection(), argvFor(), environment);
      expect({ name, code: refusal.code, layer: refusal.layer }).toEqual({
        name, code: "CLAUDE_LAUNCH_EFFORT_MISMATCH", layer: "TELEMETRY_CONFIGURATION" });
      // An override refusal may not echo the override value either.
      for (const secret of Object.values(environment)) {
        if (secret.length > 0) expect(refusal.serialized).not.toContain(secret);
      }
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses an environment that overrides the model argv proved", () => {
    const cases: readonly (readonly [string, Record<string, string>])[] = [
      ["alias", { ...NO_ENV, ANTHROPIC_MODEL: ALIAS }],
      ["other-dated", { ...NO_ENV, ANTHROPIC_MODEL: "claude-opus-5-20260515" }],
      ["empty", { ...NO_ENV, ANTHROPIC_MODEL: "" }],
      ["case-variant-name", { ...NO_ENV, Anthropic_Model: ALIAS }],
      ["lowercase-name", { ...NO_ENV, anthropic_model: ALIAS }],
    ];
    expect(cases.length).toBe(5);
    let ran = 0;
    for (const [name, environment] of cases) {
      const refusal = refusalOf(selection(), argvFor(), environment);
      expect({ name, code: refusal.code, layer: refusal.layer }).toEqual({
        name, code: "CLAUDE_LAUNCH_MODEL_MISMATCH", layer: "TELEMETRY_CONFIGURATION" });
      for (const secret of Object.values(environment)) {
        if (secret.length > 0) expect(refusal.serialized).not.toContain(secret);
      }
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("accepts an environment that agrees, and invents no override it never measured", () => {
    const cases: readonly (readonly [string, Record<string, string>])[] = [
      ["absent", { ...NO_ENV }],
      ["empty", {}],
      ["agreeing-effort", { ...NO_ENV, CLAUDE_CODE_EFFORT_LEVEL: EFFORT }],
      ["agreeing-model", { ...NO_ENV, ANTHROPIC_MODEL: MODEL }],
      ["agreeing-both", { CLAUDE_CODE_EFFORT_LEVEL: EFFORT, ANTHROPIC_MODEL: MODEL }],
      // CLAUDE_EFFORT is EXPORTED by the provider to hooks and Bash, never read
      // as an override. Refusing on it would refuse launches the provider
      // honours, so this is the measurement's negative control.
      ["exported-not-read", { ...NO_ENV, CLAUDE_EFFORT: "low" }],
      ["unrelated", { ...NO_ENV, ANTHROPIC_DEFAULT_OPUS_MODEL: ALIAS }],
      // Case-insensitive matching must not turn into a case-insensitive BAN:
      // a differently-spelled name that AGREES still launches.
      ["agreeing-case-variant", { ...NO_ENV, Claude_Code_Effort_Level: EFFORT }],
    ];
    expect(cases.length).toBe(8);
    let ran = 0;
    for (const [name, environment] of cases) {
      const verdict = verifyLaunchSelection(selection(), argvFor(), environment);
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: true });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });

  it("refuses two spellings of one override name rather than guessing which wins", () => {
    // On win32 the OS keeps one of them and this gate does not get to choose, so
    // duplicate evidence is refused as ambiguous exactly as duplicate argv is.
    const effort = refusalOf(selection(), argvFor(),
      { CLAUDE_CODE_EFFORT_LEVEL: EFFORT, Claude_Code_Effort_Level: EFFORT });
    expect({ code: effort.code, layer: effort.layer }).toEqual({
      code: "CLAUDE_LAUNCH_EFFORT_AMBIGUOUS", layer: "TELEMETRY_CONFIGURATION" });
    const model = refusalOf(selection(), argvFor(),
      { ANTHROPIC_MODEL: MODEL, anthropic_model: MODEL });
    expect({ code: model.code, layer: model.layer }).toEqual({
      code: "CLAUDE_LAUNCH_MODEL_AMBIGUOUS", layer: "TELEMETRY_CONFIGURATION" });
  });

  it("refuses an environment that is not a bounded plain string record", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["undefined", undefined],
      ["array", [["CLAUDE_CODE_EFFORT_LEVEL", "low"]]],
      ["non-string-value", { CLAUDE_CODE_EFFORT_LEVEL: 5 }],
      ["accessor", Object.defineProperty({}, "CLAUDE_CODE_EFFORT_LEVEL",
        { enumerable: true, get: () => "low" })],
      ["nul-byte", { CLAUDE_CODE_EFFORT_LEVEL: `lo${String.fromCharCode(0)}w` }],
    ];
    expect(cases.length).toBe(6);
    let ran = 0;
    for (const [name, environment] of cases) {
      const refusal = refusalOf(selection(), argvFor(), environment);
      expect({ name, code: refusal.code, layer: refusal.layer }).toEqual({
        name, code: "CLAUDE_LAUNCH_SELECTION_MALFORMED", layer: "TELEMETRY_CONFIGURATION" });
      ran += 1;
    }
    expect(ran).toBe(cases.length);
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
      const verdict = verifyLaunchSelection(value, argv, NO_ENV);
      expect({ name, ok: verdict.ok }).toEqual({ name, ok: false });
      if (verdict.ok) throw new Error(`${name} was accepted`);
      expect(verdict.code).toBe("CLAUDE_LAUNCH_SELECTION_MALFORMED");
      expect(verdict.layer).toBe("TELEMETRY_CONFIGURATION");
      ran += 1;
    }
    expect(ran).toBe(cases.length);
  });
});
