/**
 * The daemon's activation-side provider-run emission seam, driven through the
 * REAL `launchClaudeWithTelemetry` and the launcher's REAL production ports —
 * no stub of the launcher and no injected `deps` anywhere below.
 *
 * WHAT EVERY CASE HERE IS GUARDING. `ok: true` does NOT mean the run succeeded.
 * The only route to the `ok: false` arm is a malformed run ref; a launcher that
 * REFUSED before any provider bytes existed and a delivery that launched no
 * process at all BOTH come back `ok: true` carrying a BLIND handoff whose facts
 * are UNKNOWN and whose `telemetryRefusal` is populated. A consumer that
 * branched on `ok` alone would report both as healthy observations and every
 * assertion that merely checked `ok` would stay green. So each case below pins
 * the exact stable code AND the layer that answered, and pins the FACTS rather
 * than the outcome flag.
 *
 * WHY THERE IS NO OBSERVED CASE, measured rather than assumed. Reaching the
 * OBSERVED arm needs all ten `ClaudeLauncherDependencies` ports, because `deps`
 * is all-or-nothing (`entry.deps ?? CLAUDE_LAUNCHER_DEFAULTS`, no merge) and the
 * default set is deliberately off the published seam. Four of those ten have no
 * published implementation: a bare-specifier probe reports TS2305 "no exported
 * member" for `prepareClaudeRuntimePin`, `registerLaunchLock`,
 * `resolveDuplicateDelivery` and `intakeProcessObservation`. Hand-building the
 * records those ports return would be reimplementing withheld runner authority
 * inside a daemon test, and running the default set instead would spawn a real
 * provider process. The NOT_ATTEMPTED case below is the one arm that reaches a
 * real production port — duplicate resolution runs ahead of everything else —
 * so it drives `resolveDuplicateDelivery` for real rather than around it.
 */
import {
  CLAUDE_LAUNCH_SELECTION_FLAGS,
  CLAUDE_RESULT_TELEMETRY_VERSION,
  CLAUDE_TELEMETRY_HANDOFF_VERSION,
  PROVIDER_TELEMETRY_LAYERS,
  type ClaudeBoundLaunchResult,
  type ClaudeLaunchSelection,
  type ClaudeLauncherAuthority,
  type ClaudeTelemetryHandoff,
} from "@moe/runner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { launchActivationProviderRun } from "./activation-telemetry-launch.js";

/**
 * TRANSPARENT instrumentation, and every word of that matters. This wrapper
 * never invents a launcher result, a handoff, an authority grant or a runner
 * port: it calls the REAL `createTelemetryBoundClaudeLauncher`, calls the REAL
 * function that factory returns, and returns that function's own answer by
 * reference. All it adds is a record of WHAT was called, IN WHICH ORDER, WITH
 * WHICH object references, and WHICH answer came back — the facts a fabricated
 * double would make unfalsifiable. A test that stubbed the factory could not
 * tell a production composition from a mock of one.
 */
const runner = vi.hoisted(() => {
  const events: string[] = [];
  const factoryArguments: unknown[] = [];
  const runArguments: unknown[] = [];
  const answers: unknown[] = [];
  return {
    events, factoryArguments, runArguments, answers,
    reset(): void {
      events.length = 0;
      factoryArguments.length = 0;
      runArguments.length = 0;
      answers.length = 0;
    },
  };
});

vi.mock("@moe/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moe/runner")>();
  return {
    ...actual,
    createTelemetryBoundClaudeLauncher: (authority: ClaudeLauncherAuthority) => {
      runner.events.push("factory");
      runner.factoryArguments.push(authority);
      const bound = actual.createTelemetryBoundClaudeLauncher(authority);
      return async (input: Parameters<typeof bound>[0]): Promise<ClaudeBoundLaunchResult> => {
        runner.events.push("run:start");
        runner.runArguments.push(input);
        const answer = await bound(input);
        runner.events.push("run:end");
        runner.answers.push(answer);
        return answer;
      };
    },
  };
});

/**
 * A witness, NOT a grant. Both capabilities record the reach and then throw, so
 * a case asserting "the authority was never called" fails loudly rather than
 * quietly succeeding, and no arm below can be answered by an authority this test
 * pretended to satisfy. `composeDurableLauncher` READS both properties when the
 * factory binds; reading is not calling, which is why plain methods are used and
 * not throwing getters.
 */
function authorityWitness(): { readonly authority: ClaudeLauncherAuthority;
  readonly calls: readonly string[] } {
  const calls: string[] = [];
  const authority: ClaudeLauncherAuthority = Object.freeze({
    consumeGrantDurably(): unknown {
      calls.push("consumeGrantDurably");
      throw new Error("the authority witness grants nothing");
    },
    commitProcessRegistration(): unknown {
      calls.push("commitProcessRegistration");
      throw new Error("the authority witness registers nothing");
    },
  });
  return { authority, calls };
}

beforeEach(() => {
  runner.reset();
});

/** The five run-identity facts, exactly as the ledger's aggregate id keys them. */
const PROVIDER_RUN = Object.freeze({
  provider: "claude" as const,
  runRef: "run:activation:1",
  effectIntentId: "intent:1",
  attemptRef: "attempt:1",
  epoch: 3,
});

const SELECTED_MODEL = "claude-opus-5-20260514";
const SELECTED_EFFORT = "high";
const SELECTION: ClaudeLaunchSelection = Object.freeze({
  provider: "claude",
  selectedModelId: SELECTED_MODEL,
  modelSnapshotKind: "DATED_SNAPSHOT",
  modelSnapshotEvidence: "claude-opus-5-20260514/build-2026-05-14",
  reasoningEffort: SELECTED_EFFORT,
  profileRevisionId: "profile-revision-19",
  configurationDigest: "1c".repeat(32),
  policyDigest: "2d".repeat(32),
  orchestrationDigest: "3e".repeat(32),
  concurrencyCeiling: 4,
});

/**
 * A claim that parses as an `EffectClaim`: five plain fields, four bounded refs
 * and a canonical UTC timestamp. Nothing here is digest-derived, so this record
 * is legal at the layer the duplicate resolver actually reads it at.
 */
const CLAIM = Object.freeze({
  claimId: "claim-1",
  intentId: "intent-1",
  wrapperIdentity: "wrapper-1",
  lockIdentity: "lock-1",
  claimedAt: "2026-08-16T00:00:00.000Z",
});

/** A string that appears nowhere a real observation could come from. */
const CALLER_SENTINEL = "caller-invented-observation";

const runtime = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  quotedObservation: { observationDigest: "4f".repeat(32) },
  installedRoot: "C:\\Claude",
  pinRoot: "C:\\Claude\\pins",
  fs: null,
  facts: null,
  clock: null,
  ...overrides,
});

function request(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    runtime: runtime(),
    duplicateDelivery: null,
    effect: null,
    attempt: null,
    grant: null,
    claim: CLAIM,
    wrapperIdentity: "wrapper-1",
    bootstrapCredentialDigest: "ab".repeat(32),
    priorRegistration: null,
    // Names a DIFFERENT model than the selection, so the pre-open selection gate
    // refuses: the REFUSED arm is reached by a real production refusal rather
    // than by a request too malformed to survive the snapshot.
    argv: [
      "--print", "hello",
      CLAUDE_LAUNCH_SELECTION_FLAGS.model, "claude-sonnet-5-20260514",
      CLAUDE_LAUNCH_SELECTION_FLAGS.effort, SELECTED_EFFORT,
    ],
    cwd: "C:\\work",
    environment: { SYSTEMROOT: "C:\\Windows" },
    reconciliation: null,
    limits: { stdoutBytes: 4_096, stderrBytes: 4_096, tailBytes: 256, timeoutMs: 1_000 },
    launchSelection: SELECTION,
    ...overrides,
  };
}

/**
 * `registration: null` with a RELEASED lock and a declared effect state is the
 * resolver's EXIT_BEFORE_LAUNCH arm: nothing was adopted and nothing was
 * launched.
 */
const DUPLICATE_DELIVERY = Object.freeze({
  claim: CLAIM,
  registration: null,
  lockState: "RELEASED",
  effectState: "ACTIVE",
});

/** win32 is pinned so the platform gate answers the same on every runner. */
const OPTIONS = Object.freeze({ platform: "win32" });

function handoffOf(result: ClaudeBoundLaunchResult): ClaudeTelemetryHandoff {
  if (!result.ok) throw new Error(`expected the handoff arm, received ${result.code}/${result.layer}`);
  return result.handoff;
}

/** The raw launcher result the bound runner returns BESIDE the handoff. */
function rawOf(result: ClaudeBoundLaunchResult): Readonly<Record<string, unknown>> {
  if (!result.ok) throw new Error(`expected the bound arm, received ${result.code}/${result.layer}`);
  return result.result as unknown as Readonly<Record<string, unknown>>;
}

const blind = (code: string): Readonly<Record<string, unknown>> =>
  ({ known: false, code, layer: "TELEMETRY_LAUNCH" });

/**
 * A run ref whose `runRef` is an ACCESSOR rather than a data property. It is a
 * plain object, so `types.isProxy` says no and `snapshotRunRef` reads the five
 * fields for real — which makes the read COUNT a measurement of how many times
 * the identity was traversed. Exactly one read means the runner alone read it;
 * two means something projected or spread it on the way there.
 */
function countingRunRef(): { readonly ref: Readonly<Record<string, unknown>>; reads(): number } {
  let reads = 0;
  const ref = Object.freeze({
    provider: "claude" as const,
    get runRef(): string {
      reads += 1;
      return "run:activation:counted";
    },
    effectIntentId: "intent:1",
    attemptRef: "attempt:1",
    epoch: 3,
  });
  return { ref, reads: () => reads };
}

describe("launchActivationProviderRun authority edge", () => {
  it("takes the authority as a separate argument and binds the real factory exactly once",
    async () => {
      const witness = authorityWitness();
      const input = { providerRun: PROVIDER_RUN, request: request(), options: OPTIONS };
      // Arity is the compiled proof that authority is MANDATORY: a defaulted or
      // optional authority would report 1 and leave the unauthoritative route
      // reachable from every existing call site.
      expect(launchActivationProviderRun.length).toBe(2);
      const answer = await launchActivationProviderRun(witness.authority, input);
      expect(runner.factoryArguments.length).toBe(1);
      // The SAME object, not a copy, not a rebuilt authority: a daemon-side
      // projection of the authority would satisfy toEqual and fail this.
      expect(runner.factoryArguments[0]).toBe(witness.authority);
      expect(runner.answers.length).toBe(1);
      // The runner's own answer, returned untouched. A rewrap or a spread in the
      // adapter produces an equal object and reddens exactly here.
      expect(answer).toBe(runner.answers[0]);
    });

  it("invokes the bound runner exactly once, after the factory, forwarding unread references",
    async () => {
      const witness = authorityWitness();
      const requestRecord = request();
      await launchActivationProviderRun(witness.authority,
        { providerRun: PROVIDER_RUN, request: requestRecord, options: OPTIONS });
      // One physical composition, one invocation, in that order. A second
      // invocation appends a second run:start/run:end pair and reddens here.
      expect(runner.events).toEqual(["factory", "run:start", "run:end"]);
      expect(runner.runArguments.length).toBe(1);
      const forwarded = runner.runArguments[0] as Readonly<Record<string, unknown>>;
      expect(Object.keys(forwarded).sort()).toEqual(["options", "providerRunRef", "request"]);
      // BY REFERENCE. `snapshotRunRef` refuses a hostile ref before reading any
      // property; a daemon that spread or projected these would run the caller's
      // accessors ahead of that guard and would fail these three identities.
      expect(forwarded.providerRunRef).toBe(PROVIDER_RUN);
      expect(forwarded.request).toBe(requestRecord);
      expect(forwarded.options).toBe(OPTIONS);
    });

  it("omits options entirely rather than forwarding an undefined slot", async () => {
    const witness = authorityWitness();
    await launchActivationProviderRun(witness.authority,
      { providerRun: PROVIDER_RUN, request: request() });
    const forwarded = runner.runArguments[0] as Readonly<Record<string, unknown>>;
    expect(Object.keys(forwarded).sort()).toEqual(["providerRunRef", "request"]);
    expect("options" in forwarded).toBe(false);
  });

  it("keeps the caller's input surface closed: no deps, launcher, exit or handoff is nameable",
    () => {
      const witness = authorityWitness();
      const base = { providerRun: PROVIDER_RUN, request: request() };
      // @ts-expect-error the authority is mandatory; the one-argument form is gone.
      void (() => launchActivationProviderRun(base));
      void (() => launchActivationProviderRun(witness.authority, {
        ...base,
        // @ts-expect-error `deps` would hand the caller the launcher's own ports.
        options: { platform: "win32", deps: {} },
      }));
      // @ts-expect-error a caller-supplied launcher would replace the authority route.
      void (() => launchActivationProviderRun(witness.authority, { ...base, launcher: () => null }));
      // @ts-expect-error an exit is a launcher fact; a caller cannot declare one.
      void (() => launchActivationProviderRun(witness.authority, { ...base, exit: { code: 0 } }));
      // @ts-expect-error an observation is minted by the runner, never supplied.
      void (() => launchActivationProviderRun(witness.authority, { ...base, observation: {} }));
      // @ts-expect-error registration is durable authority state, not caller input.
      void (() => launchActivationProviderRun(witness.authority, { ...base, registration: {} }));
      // @ts-expect-error reconciliation belongs inside the request the launcher reads.
      void (() => launchActivationProviderRun(witness.authority, { ...base, reconciliation: {} }));
      // @ts-expect-error the handoff is the ANSWER; a caller cannot pass one in.
      void (() => launchActivationProviderRun(witness.authority, { ...base, handoff: {} }));
      // The only two option keys that exist, proven positively so the fixtures
      // above cannot pass by the whole options slot being unrepresentable.
      const controller = new AbortController();
      void (() => launchActivationProviderRun(witness.authority,
        { ...base, options: { platform: "win32", signal: controller.signal } }));
      expect(witness.calls).toEqual([]);
    });
});

describe("launchActivationProviderRun real bound results", () => {
  it("returns the raw EXIT_BEFORE_LAUNCH result beside its own blind handoff, read once",
    async () => {
      const witness = authorityWitness();
      const identity = countingRunRef();
      const answer = await launchActivationProviderRun(witness.authority, {
        providerRun: identity.ref as never,
        request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
        options: OPTIONS,
      });
      // The bound arm carries BOTH, out of ONE launch.
      expect(answer.ok).toBe(true);
      if (!answer.ok) throw new Error(`expected the bound arm, received ${answer.code}`);
      expect(Object.keys(answer).sort()).toEqual(["handoff", "ok", "result"]);
      expect(Object.isFrozen(answer)).toBe(true);
      const raw = rawOf(answer);
      // The LAUNCHER's own truth, which the handoff alone cannot express: this
      // arm proves no process started, and says so with code and layer null.
      expect(raw.kind).toBe("EXIT_BEFORE_LAUNCH");
      expect(raw.launched).toBe(false);
      expect(raw.truthClass).toBe("PROVEN");
      expect(raw.code).toBeNull();
      expect(raw.layer).toBeNull();
      // SAME capture: the handoff is derived from that exact result, not from a
      // second launch, so the two agree field for field.
      expect(answer.handoff.launch.kind).toBe(raw.kind);
      expect(answer.handoff.launch.truthClass).toBe(raw.truthClass);
      expect(answer.handoff.launch.reasonCode).toBeNull();
      expect(answer.handoff.launch.reasonLayer).toBeNull();
      expect(answer.handoff.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_NOT_ATTEMPTED");
      expect(answer.handoff.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      expect(answer.handoff.terminal).toBe("UNKNOWN");
      // Read ONCE, by the runner. A daemon-side spread reads it a second time.
      expect(identity.reads()).toBe(1);
      expect(runner.events).toEqual(["factory", "run:start", "run:end"]);
      // PROVEN here means "proven that nothing launched", so the authority that
      // grants and registers a real process was never reached.
      expect(witness.calls).toEqual([]);
    });

  it("preserves the launcher's own refusal code beside the telemetry layer's, unmerged",
    async () => {
      const witness = authorityWitness();
      const answer = await launchActivationProviderRun(witness.authority,
        { providerRun: PROVIDER_RUN, request: request(), options: OPTIONS });
      const raw = rawOf(answer);
      // The LAUNCHER refused, at its own layer, with its own code.
      expect(raw.kind).toBe("REFUSED");
      expect(raw.code).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
      expect(raw.layer).toBe("TELEMETRY_CONFIGURATION");
      expect(raw.truthClass).toBe("UNKNOWN");
      const handoff = handoffOf(answer);
      // The TELEMETRY layer refused separately, and neither restamped the other.
      expect(handoff.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
      expect(handoff.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      expect(handoff.launch.reasonCode).toBe(raw.code);
      expect(handoff.launch.reasonLayer).toBe(raw.layer);
      expect(handoff.telemetryRefusal?.code).not.toBe(handoff.launch.reasonCode);
      expect(handoff.telemetryRefusal?.layer).not.toBe(handoff.launch.reasonLayer);
      // An unmeasured quantity is UNKNOWN carrying its code, never a zero.
      expect(handoff.tokens.inputTokens).toEqual(
        { known: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH" });
      expect(handoff.tokens.inputTokens).not.toHaveProperty("value");
      expect(witness.calls).toEqual([]);
    });

  it("forwards a runtime-cast deps object instead of stripping it, and the LAUNCHER refuses it",
    async () => {
      const witness = authorityWitness();
      const dependencyCalls: string[] = [];
      const smuggledDeps = {
        prepareRuntime: (): unknown => {
          dependencyCalls.push("prepareRuntime");
          return null;
        },
        resolveDuplicate: (): unknown => {
          dependencyCalls.push("resolveDuplicate");
          return null;
        },
      };
      const answer = await launchActivationProviderRun(witness.authority, {
        providerRun: PROVIDER_RUN,
        request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
        // Only a runtime cast can name `deps`; the typed surface cannot.
        options: { platform: "win32", deps: smuggledDeps } as never,
      });
      // FORWARDED, so the layer that owns dependency policy is the layer that
      // answers. A daemon that silently deleted `deps` would produce a healthy
      // NOT_ATTEMPTED handoff here and hide the smuggling attempt entirely.
      const forwarded = runner.runArguments[0] as Readonly<Record<string, unknown>>;
      expect((forwarded.options as Readonly<Record<string, unknown>>).deps).toBe(smuggledDeps);
      const raw = rawOf(answer);
      expect(raw.kind).toBe("REFUSED");
      expect(raw.code).toBe("CLAUDE_LAUNCH_REQUEST_MALFORMED");
      expect(raw.layer).toBe("LAUNCHER");
      // The launcher's static message names WHICH refusal answered, separating
      // this from the identically-coded malformed-request path.
      expect(raw.message).toBe("the durable launcher composes its own shipped dependencies");
      expect(handoffOf(answer).telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
      expect(handoffOf(answer).telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      // Neither the smuggled ports nor the real authority was ever honoured.
      expect(dependencyCalls).toEqual([]);
      expect(witness.calls).toEqual([]);
    });
});

describe("launchActivationProviderRun hostile run identity", () => {
  const hostile = (): readonly { readonly label: string; readonly ref: unknown }[] => {
    const revoked = Proxy.revocable({ ...PROVIDER_RUN }, {});
    revoked.revoke();
    return [
      {
        label: "epoch-missing",
        ref: { provider: "claude", runRef: "r", effectIntentId: "i", attemptRef: "a" },
      },
      { label: "epoch-fractional", ref: { ...PROVIDER_RUN, epoch: 1.5 } },
      { label: "epoch-negative", ref: { ...PROVIDER_RUN, epoch: -1 } },
      { label: "epoch-text", ref: { ...PROVIDER_RUN, epoch: "3" } },
      { label: "provider-foreign", ref: { ...PROVIDER_RUN, provider: "codex" } },
      { label: "run-ref-space", ref: { ...PROVIDER_RUN, runRef: "run ref with a space" } },
      { label: "run-ref-overlong", ref: { ...PROVIDER_RUN, runRef: "r".repeat(201) } },
      { label: "run-ref-empty", ref: { ...PROVIDER_RUN, runRef: "" } },
      { label: "attempt-ref-nonstring", ref: { ...PROVIDER_RUN, attemptRef: 7 } },
      {
        label: "accessor-invalid",
        ref: {
          provider: "claude", effectIntentId: "i", attemptRef: "a", epoch: 3,
          get runRef(): unknown {
            return null;
          },
        },
      },
      {
        label: "proxy-throwing",
        ref: new Proxy({ ...PROVIDER_RUN }, {
          get(): never {
            throw new Error("the trap must never run");
          },
        }),
      },
      { label: "proxy-revoked", ref: revoked.proxy },
      { label: "not-an-object", ref: "run:activation:1" },
      { label: "null", ref: null },
    ];
  };

  it("generates a labelled matrix of distinct hostile identities", () => {
    const cases = hostile();
    // A sweep that silently produced nothing would pass every assertion below
    // it, so the generated count is pinned exactly and the labels must be unique.
    expect(cases.length).toBe(14);
    expect(new Set(cases.map((entry) => entry.label)).size).toBe(cases.length);
  });

  it.each(hostile())(
    "refuses $label at TELEMETRY_INPUT before the authority, the request or any process",
    async ({ ref }) => {
      const witness = authorityWitness();
      const requestReads: string[] = [];
      // The request's own getters are the tripwire: had anything read the
      // request before the identity was judged, the refusing layer would move.
      const hostileRequest = {
        get argv(): unknown {
          requestReads.push("argv");
          return [];
        },
        get claim(): unknown {
          requestReads.push("claim");
          return CLAIM;
        },
      };
      const answer = await launchActivationProviderRun(witness.authority,
        { providerRun: ref as never, request: hostileRequest, options: OPTIONS });
      expect(answer.ok).toBe(false);
      if (answer.ok) throw new Error("a malformed run ref must not produce a bound result");
      expect(answer.code).toBe("TELEMETRY_RUN_REF_MALFORMED");
      expect(answer.layer).toBe("TELEMETRY_INPUT");
      expect(PROVIDER_TELEMETRY_LAYERS).toContain(answer.layer);
      // No result, no handoff, no authority, no request read: refused first.
      expect(answer).not.toHaveProperty("result");
      expect(answer).not.toHaveProperty("handoff");
      expect(witness.calls).toEqual([]);
      expect(requestReads).toEqual([]);
      // The factory still bound once; only the RUN was refused before launching.
      expect(runner.events).toEqual(["factory", "run:start", "run:end"]);
    });

  it("leaves smuggled result and handoff getters on the input unread", async () => {
    const witness = authorityWitness();
    const smuggled: string[] = [];
    const input = {
      providerRun: PROVIDER_RUN,
      request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      options: OPTIONS,
      get authority(): unknown {
        smuggled.push("authority");
        return witness.authority;
      },
      get result(): unknown {
        smuggled.push("result");
        return { kind: "OBSERVED" };
      },
      get handoff(): unknown {
        smuggled.push("handoff");
        return { terminal: "COMPLETED" };
      },
    };
    const answer = await launchActivationProviderRun(witness.authority, input as never);
    // Only the three real keys are read off the caller's input; a smuggled
    // observation never becomes one.
    expect(smuggled).toEqual([]);
    expect(handoffOf(answer).terminal).toBe("UNKNOWN");
    expect(rawOf(answer).kind).toBe("EXIT_BEFORE_LAUNCH");
  });
});

describe("launchActivationProviderRun", () => {
  it("refuses a malformed run ref at TELEMETRY_INPUT and launches nothing", async () => {
    const witness = authorityWitness();
    const result = await launchActivationProviderRun(witness.authority, {
      // A space is outside the bounded-ref alphabet /^[!-~]{1,200}$/u.
      providerRun: { ...PROVIDER_RUN, runRef: "run ref with a space" },
      request: request(),
      options: OPTIONS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a malformed run ref must not produce a handoff");
    expect(result.code).toBe("TELEMETRY_RUN_REF_MALFORMED");
    expect(result.layer).toBe("TELEMETRY_INPUT");
    expect(PROVIDER_TELEMETRY_LAYERS).toContain(result.layer);
  });

  it("reports a REFUSED launch as a blind handoff, never as an observation", async () => {
    const handoff = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
      providerRun: PROVIDER_RUN, request: request(), options: OPTIONS,
    }));
    // The trap this case exists for: the arm is ok:true.
    expect(handoff.telemetryRefusal).toEqual({
      ok: false, code: "TELEMETRY_LAUNCH_REFUSED", layer: "TELEMETRY_LAUNCH",
      message: "the launcher refused before any provider bytes existed",
    });
    expect(handoff.terminal).toBe("REFUSED");
    expect(handoff.infrastructure).toBe("LAUNCH_REFUSED");
    expect(handoff.launch.kind).toBe("REFUSED");
    // The launcher's OWN code and layer, forwarded verbatim and unwrapped.
    expect(handoff.launch.reasonCode).toBe("CLAUDE_LAUNCH_MODEL_MISMATCH");
    expect(handoff.launch.reasonLayer).toBe("TELEMETRY_CONFIGURATION");
    expect(handoff.launch.exit).toBeNull();
    expect(handoff.launch.observationDigest).toBeNull();
  });

  it("reports a delivery that launched nothing as NOT_ATTEMPTED, distinct from REFUSED", async () => {
    const notAttempted = handoffOf(await launchActivationProviderRun(
      authorityWitness().authority, {
        providerRun: PROVIDER_RUN,
        request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
        options: OPTIONS,
      }));
    const refused = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
      providerRun: PROVIDER_RUN, request: request(), options: OPTIONS,
    }));
    expect(notAttempted.telemetryRefusal).toEqual({
      ok: false, code: "TELEMETRY_LAUNCH_NOT_ATTEMPTED", layer: "TELEMETRY_LAUNCH",
      message: "this delivery launched no process of its own",
    });
    expect(notAttempted.terminal).toBe("UNKNOWN");
    expect(notAttempted.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
    expect(notAttempted.launch.kind).toBe("EXIT_BEFORE_LAUNCH");
    // Both arms are ok:true blind handoffs. Collapsing them would lose WHICH
    // happened, so every field that separates them is pinned as different.
    expect(notAttempted.telemetryRefusal?.code).not.toBe(refused.telemetryRefusal?.code);
    expect(notAttempted.terminal).not.toBe(refused.terminal);
    expect(notAttempted.infrastructure).not.toBe(refused.infrastructure);
    expect(notAttempted.launch.kind).not.toBe(refused.launch.kind);
    // A PROVEN launch truth class here means "proven that no process started",
    // NOT a proven run. The facts below are what say the run is unobserved, and
    // reading this flag as run authority is the misread the pairing guards.
    expect(notAttempted.launch.truthClass).toBe("PROVEN");
    expect(notAttempted.telemetryRefusal).not.toBeNull();
  });

  it("returns the runner's own handoff, not a daemon-composed lookalike", async () => {
    const handoff = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
      providerRun: PROVIDER_RUN,
      request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      options: OPTIONS,
    }));
    expect(handoff.handoffVersion).toBe(CLAUDE_TELEMETRY_HANDOFF_VERSION);
    expect(handoff.parserVersion).toBe(CLAUDE_RESULT_TELEMETRY_VERSION);
    // The five identity facts arrive as the runner's own frozen snapshot of
    // them — not the object this test passed in, and carrying nothing else.
    expect(handoff.providerRunRef).toEqual(PROVIDER_RUN);
    expect(handoff.providerRunRef).not.toBe(PROVIDER_RUN);
    expect(Object.keys(handoff.providerRunRef).sort()).toEqual(
      ["attemptRef", "effectIntentId", "epoch", "provider", "runRef"]);
    // Deep-frozen by the producer. A lookalike assembled from object spreads in
    // the daemon would satisfy the field names and fail these.
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.tokens)).toBe(true);
    expect(Object.isFrozen(handoff.launch)).toBe(true);
  });

  it("renders every unmeasured fact as UNKNOWN carrying its code, never as zero", async () => {
    const cases = [
      { code: "TELEMETRY_LAUNCH_REFUSED", request: request() },
      {
        code: "TELEMETRY_LAUNCH_NOT_ATTEMPTED",
        request: request({ duplicateDelivery: DUPLICATE_DELIVERY }),
      },
    ] as const;
    expect(cases.length).toBe(2);
    for (const scenario of cases) {
      const handoff = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
        providerRun: PROVIDER_RUN, request: scenario.request, options: OPTIONS,
      }));
      const fact = blind(scenario.code);
      expect(handoff.tokens).toEqual({
        inputTokens: fact, outputTokens: fact, cacheCreationInputTokens: fact,
        cacheReadInputTokens: fact, coverage: "UNKNOWN",
      });
      expect(handoff.steps).toEqual({ turns: fact, coverage: "UNKNOWN" });
      expect(handoff.sequence).toEqual(fact);
      expect(handoff.stdoutReceiptDigest).toEqual(fact);
      expect(handoff.stderrReceiptDigest).toEqual(fact);
      expect(handoff.observedModel.modelId).toEqual(fact);
      expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
      // The distinction the whole quantity union exists for: an unmeasured count
      // must never arrive as a measured zero.
      expect(handoff.tokens.inputTokens).not.toHaveProperty("value");
      expect(handoff.steps.turns).not.toHaveProperty("value");
    }
  });

  it("never echoes a caller-supplied timing pair, model snapshot or effort as an observation",
    async () => {
      // The planted values sit in fields the caller LEGITIMATELY supplies —
      // `effect`, `attempt` and the quoted observation are the caller's own
      // records, carried as plain data. That keeps the fixture valid at the
      // request snapshot and at the duplicate resolver, so this case is answered
      // by the observation discipline rather than by an earlier structural
      // guard. Planting the same names at the TOP level is covered separately
      // below, where the exact-record read refuses the whole request instead.
      const handoff = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
        providerRun: PROVIDER_RUN,
        request: request({
          duplicateDelivery: DUPLICATE_DELIVERY,
          effect: {
            startedAt: "1999-01-01T00:00:00.000Z",
            completedAt: "1999-01-01T00:00:09.000Z",
            observedModel: CALLER_SENTINEL,
            tokens: { inputTokens: 999, outputTokens: 999 },
            terminal: "COMPLETED",
            infrastructure: "NONE",
          },
          attempt: { modelSnapshotEvidence: CALLER_SENTINEL, reasoningEffort: SELECTED_EFFORT },
          runtime: runtime({
            quotedObservation: { observationDigest: "4f".repeat(32), model: CALLER_SENTINEL },
          }),
        }),
        options: OPTIONS,
      }));
      const unmeasured = blind("TELEMETRY_LAUNCH_NOT_ATTEMPTED");
      expect(handoff.launch.startedAt).toBeNull();
      expect(handoff.launch.completedAt).toBeNull();
      expect(handoff.observedModel.modelId).toEqual(unmeasured);
      expect(handoff.observedModel.snapshotEvidence).toEqual(unmeasured);
      expect(handoff.observedModel.snapshotKind).toBe("UNKNOWN");
      expect(handoff.tokens.inputTokens).toEqual(unmeasured);
      expect(handoff.terminal).toBe("UNKNOWN");
      expect(handoff.infrastructure).toBe("LAUNCH_NOT_ATTEMPTED");
      // Nothing the caller planted reaches ANY field of the handoff, not just
      // the fields this case thought to name.
      expect(JSON.stringify(handoff)).not.toContain(CALLER_SENTINEL);
      expect(JSON.stringify(handoff)).not.toContain("1999-01-01");
      // The reasoning effort the caller DID have standing to declare stays on
      // the DECLARED side and never crosses into the observed model.
      expect(handoff.declared).toEqual({ known: true, selection: SELECTION });
      expect(JSON.stringify(handoff.observedModel)).not.toContain(SELECTED_EFFORT);
      expect(JSON.stringify(handoff.observedModel)).not.toContain(SELECTED_MODEL);
    });

  it("refuses a request that carries handoff-shaped observation fields at the top level",
    async () => {
      const handoff = handoffOf(await launchActivationProviderRun(authorityWitness().authority, {
        providerRun: PROVIDER_RUN,
        request: request({
          duplicateDelivery: DUPLICATE_DELIVERY,
          startedAt: "1999-01-01T00:00:00.000Z",
          completedAt: "1999-01-01T00:00:09.000Z",
          observedModel: CALLER_SENTINEL,
          terminal: "COMPLETED",
        }),
        options: OPTIONS,
      }));
      // The request is read as an EXACT record, so smuggled observation fields
      // do not travel and are not silently dropped either: the whole request is
      // refused, ahead of the duplicate resolution this same fixture would
      // otherwise have reached.
      expect(handoff.launch.kind).toBe("REFUSED");
      expect(handoff.launch.reasonCode).toBe("CLAUDE_LAUNCH_REQUEST_MALFORMED");
      expect(handoff.launch.reasonLayer).toBe("LAUNCHER");
      expect(handoff.telemetryRefusal?.code).toBe("TELEMETRY_LAUNCH_REFUSED");
      expect(handoff.telemetryRefusal?.layer).toBe("TELEMETRY_LAUNCH");
      expect(handoff.launch.startedAt).toBeNull();
      expect(JSON.stringify(handoff)).not.toContain(CALLER_SENTINEL);
    });
});
