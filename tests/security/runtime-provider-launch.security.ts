/**
 * HOSTILE COVERAGE — the PROVIDER LAUNCH, RENDER, TELEMETRY AND USAGE group of the
 * runtime-provider axis. Seven of the roster's twenty-two entries; the partition is declared in
 * `runtime-provider-ledger.ts` and its union is checked against the roster in the evidence file.
 *
 * THE TRAP THAT WOULD OTHERWISE MAKE HALF THIS FILE VACUOUS, measured at
 * `claude-telemetry-launch.ts:206`: `launchClaudeWithTelemetry` returns `ok: true` for a
 * launcher that REFUSED and for a delivery that was NOT ATTEMPTED. Both carry a BLIND handoff
 * whose facts are UNKNOWN and whose `telemetryRefusal` is populated; the ONLY route to
 * `ok: false` is a malformed run ref. Nothing here branches on `ok` — the cases assert
 * `handoff.telemetryRefusal`, `handoff.terminal` and `handoff.infrastructure`, and pin
 * `TELEMETRY_LAUNCH_REFUSED` and `TELEMETRY_LAUNCH_NOT_ATTEMPTED` as DISTINCT shapes.
 *
 * FIVE LAYERS CAN ANSWER the telemetry seam, and the contract's own comment says a code-only
 * assertion "would stay green once a different layer started answering first". Every fixture
 * below is built from `capture(...)`, which is coherent at TELEMETRY_INPUT and TELEMETRY_CAPTURE,
 * and breaks exactly ONE thing — so the arranged layer is provably the one that answered.
 *
 * NO TEST PRINTS PROVIDER OUTPUT. Poisoned bytes are never logged, and the message-hygiene
 * property runs over the WHOLE refusal set rather than one example: `PROVIDER_TELEMETRY_MESSAGES`
 * are static and non-interpolating precisely so a failure path cannot echo a captured byte, a
 * model name or a digest back out.
 */

import { describe, expect, it } from "vitest";

import {
  PROVIDER_RUN_LEDGER_LAYERS,
  providerRunRefusal,
} from "../../apps/daemon/src/telemetry/provider-run-refusals.js";
import {
  decodeProviderRunRecord,
  encodeProviderRunRecord,
} from "../../apps/daemon/src/telemetry/provider-run-codec.js";
import { launchClaude } from "../../packages/runner/src/providers/claude/claude-launcher.js";
import {
  CLAUDE_LAUNCH_LAYERS,
  CLAUDE_LAUNCH_SELECTION_LAYER,
} from "../../packages/runner/src/providers/claude/claude-launcher-contract.js";
import { verifyLaunchSelection } from "../../packages/runner/src/providers/claude/claude-launch-verify.js";
import { CLAUDE_RENDER_LAYERS, renderClaudeContext } from "../../packages/runner/src/providers/claude/claude-render.js";
import type { RenderClaudeContextInput } from "../../packages/runner/src/providers/claude/claude-render.js";
import { CODEX_RENDER_LAYERS, renderCodexContext } from "../../packages/runner/src/providers/codex/codex-render.js";
import type { RenderCodexContextInput } from "../../packages/runner/src/providers/codex/codex-render.js";
import { parseClaudeResultTelemetry } from "../../packages/runner/src/providers/telemetry/claude-result-telemetry.js";
import { PROVIDER_TELEMETRY_LAYERS } from "../../packages/runner/src/providers/telemetry/provider-telemetry-contracts.js";
import { PROVIDER_USAGE_LAYERS } from "../../packages/runner/src/providers/telemetry/provider-usage-contracts.js";
import { normalizeProviderUsage } from "../../packages/runner/src/providers/telemetry/provider-usage-normalization.js";
import type { ClaudeTelemetryHandoff } from "../../packages/runner/src/providers/telemetry/claude-telemetry-launch.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  AMBIGUOUS_STREAM,
  LAUNCH_SECRETS,
  OUT_OF_ORDER_STREAM,
  POISON_DIGEST,
  POISON_PATH,
  GOOD_RUN_REF as REF,
  UNSUPPORTED_SCHEMA_STREAM,
  capture,
  initLine,
  refusedByManifestLayer,
  refusedTelemetry,
  renderInput,
  resultLine,
  skillSnapshot,
} from "./runtime-provider-launch-fixtures.js";
import {
  RUNTIME_BOUND as BOUND,
  RUNTIME_PROVIDER_PARTITION,
  createLedger,
  describeSliceInvariants,
  hostile,
  layerOf,
} from "./runtime-provider-ledger.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.LAUNCH;
const ledger = createLedger();

const CAPTURE = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_CAPTURE");
const INPUT = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_INPUT");
const SCHEMA = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_SCHEMA");
const USAGE_INPUT = layerOf(PROVIDER_USAGE_LAYERS, "USAGE_INPUT");
const CODEC = layerOf(PROVIDER_RUN_LEDGER_LAYERS, "PROVIDER_RUN_CODEC");
const LAUNCHER = layerOf(CLAUDE_LAUNCH_LAYERS, "LAUNCHER");

const parse = (stdout: unknown, providerRunRef: unknown = REF): unknown =>
  parseClaudeResultTelemetry(hostile({ providerRunRef, stdout }));

/** The excluded SKILLS_ADVISORY entry off a production manifest, or undefined if the render
 *  refused outright — which the caller asserts rather than tolerates. */
const advisoryEntry = (result: { ok: boolean; rendered?: { layerManifest: readonly unknown[] } }): unknown =>
  result.rendered?.layerManifest.find(
    (entry) => (entry as { layer?: string }).layer === "SKILLS_ADVISORY",
  );

// ── PROVIDER_TELEMETRY_LAYERS ─────────────────────────────────────────────────────────────
// Poisoned provider output. Every fixture is a COHERENT capture with exactly one thing broken,
// so the layer named below is provably the one that answered rather than an earlier one.
describe("PROVIDER_TELEMETRY_LAYERS", () => {
  const boundary = "PROVIDER_TELEMETRY_LAYERS";

  it("BEFORE — bytes that do not decode to their declared digest are refused at CAPTURE", async () => {
    const good = capture(`${initLine("claude-a")}\n${resultLine()}`);
    const outcome = await probeBefore(
      BOUND,
      // Digest swapped, everything else coherent: TELEMETRY_INPUT cannot answer.
      async () => parse({ ...good, sha256: POISON_DIGEST }),
      async () => parse({ ...good, byteLength: good.byteLength + 1 }),
    );
    refusedTelemetry(ledger, boundary, "BEFORE", outcome.probe, "TELEMETRY_CAPTURE_UNDECODABLE", CAPTURE);
    refusedTelemetry(ledger, boundary, "BEFORE", outcome.effect, "TELEMETRY_CAPTURE_UNDECODABLE", CAPTURE);
  });

  it("AFTER — a truncated and an unfinished capture keep DISTINCT codes at the same layer", async () => {
    const good = capture(resultLine());
    const outcome = await probeAfter(
      BOUND,
      async () => parse({ ...good, truncated: true }),
      async () => parse({ ...good, complete: false }),
    );
    // Two branches at ONE layer: pinned separately so neither could answer for the other.
    refusedTelemetry(ledger, boundary, "AFTER", outcome.effect, "TELEMETRY_CAPTURE_TRUNCATED", CAPTURE);
    refusedTelemetry(ledger, boundary, "AFTER", outcome.probe, "TELEMETRY_CAPTURE_INCOMPLETE", CAPTURE);
  });

  it("RACE — a malformed run ref and an unsupported schema answer at DIFFERENT layers", async () => {
    const outcome = await probeRacing(
      BOUND,
      // Capture coherent, ref hostile: TELEMETRY_INPUT is arranged to answer.
      async () => parse(capture(resultLine()), { runRef: 1 }),
      async () => parse(capture(UNSUPPORTED_SCHEMA_STREAM)),
    );
    ledger.refusedSide(boundary, outcome.left, { code: "TELEMETRY_RUN_REF_MALFORMED", layer: INPUT });
    ledger.refusedSide(boundary, outcome.right, {
      code: "TELEMETRY_SCHEMA_UNSUPPORTED",
      layer: SCHEMA,
    });
  });
});

// ── CLAUDE_LAUNCH_LAYERS ──────────────────────────────────────────────────────────────────
// The launcher. Its refusals carry their own layer, and the selection defect is answered at
// TELEMETRY_CONFIGURATION rather than LAUNCHER — the two are pinned apart deliberately.
describe("CLAUDE_LAUNCH_LAYERS", () => {
  const boundary = "CLAUDE_LAUNCH_LAYERS";
  const malformed = { code: "CLAUDE_LAUNCH_REQUEST_MALFORMED", layer: LAUNCHER };

  it("BEFORE — an unresolvable request is refused before any process exists", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => await launchClaude(null),
      async () => await launchClaude({ executable: POISON_PATH }),
    );
    ledger.refused(boundary, "BEFORE", outcome.probe, malformed);
    ledger.refused(boundary, "BEFORE", outcome.effect, malformed);
  });

  it("AFTER — a hostile launch operand answers at the SELECTION layer, not the launcher's", async () => {
    const trap = { get argv(): never { throw new Error("reflection must not run"); } };
    const outcome = await probeAfter(
      BOUND,
      async () => await launchClaude(hostile(trap)),
      async () => await launchClaude(hostile(new Proxy({}, {}))),
    );
    // Pinned INDIVIDUALLY and at DIFFERENT layers: a proxy is read as hostile before any
    // property is touched and answers at the selection layer, while a throwing accessor is
    // contained by the snapshot and answers as the launcher's own malformed request.
    ledger.refused(boundary, "AFTER", outcome.effect, malformed);
    ledger.refused(boundary, "AFTER", outcome.probe, {
      code: "CLAUDE_LAUNCH_SELECTION_MALFORMED",
      layer: CLAUDE_LAUNCH_SELECTION_LAYER,
    });
  });

  it("RACE — two hostile launches contend and neither reports a launched process", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => await launchClaude(hostile<unknown>([])),
      async () => await launchClaude(hostile<unknown>("launch")),
    );
    for (const side of [outcome.left, outcome.right]) {
      expect(side.status).toBe("fulfilled");
      expect((side as { value: { launched?: unknown } }).value.launched).not.toBe(true);
      ledger.refusedSide(boundary, side, malformed);
    }
  });
});

// ── CLAUDE_LAUNCH_SELECTION_LAYER ─────────────────────────────────────────────────────────
// The argv/environment proof. Model and effort keep SEPARATE codes so the two comparisons can
// be mutated independently; each fixture is valid at the arms above the one under test.
describe("CLAUDE_LAUNCH_SELECTION_LAYER", () => {
  const boundary = "CLAUDE_LAUNCH_SELECTION_LAYER";
  const layer = CLAUDE_LAUNCH_SELECTION_LAYER;
  const selection = {
    provider: "claude",
    selectedModelId: "claude-opus-5",
    modelSnapshotKind: "DATED_SNAPSHOT",
    modelSnapshotEvidence: "2026-05-01",
    reasoningEffort: "high",
    profileRevisionId: "profile-1",
    concurrencyCeiling: 4,
    launchSelectionDigest: POISON_DIGEST,
    resolvedRuntimeDigest: POISON_DIGEST,
  };

  it("BEFORE — a selection that is not exact bounded plain data cannot prove anything", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => verifyLaunchSelection(null, [], {}),
      async () => verifyLaunchSelection({ ...selection, concurrencyCeiling: -1 }, [], {}),
    );
    const malformed = { code: "CLAUDE_LAUNCH_SELECTION_MALFORMED", layer };
    ledger.refused(boundary, "BEFORE", outcome.probe, malformed);
    ledger.refused(boundary, "BEFORE", outcome.effect, malformed);
  });

  it("AFTER — an argv that resumes a prior session defeats the model AND effort arms at once", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => verifyLaunchSelection(selection, ["--resume", "sess-1"], {}),
      async () => verifyLaunchSelection(selection, [], {}),
    );
    ledger.refused(boundary, "AFTER", outcome.effect, {
      code: "CLAUDE_LAUNCH_SESSION_RESUMED",
      layer,
    });
    // Not resumed, so the resume arm provably could not answer; the model arm did.
    ledger.refused(boundary, "AFTER", outcome.probe, { code: "CLAUDE_LAUNCH_MODEL_UNPROVEN", layer });
  });

  it("RACE — an injected model flag and an injected environment value are both refused", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => verifyLaunchSelection(selection, ["--model", "claude-a"], {}),
      async () =>
        verifyLaunchSelection(selection, ["--model", selection.selectedModelId], {
          MOE_CLAUDE_SELECTED_MODEL: "claude-a",
        }),
    );
    ledger.refusedSide(boundary, outcome.left, { code: "CLAUDE_LAUNCH_MODEL_MISMATCH", layer });
    // The model arm is satisfied by argv here, so whatever answers is the EFFORT arm.
    ledger.refusedSide(boundary, outcome.right, { code: "CLAUDE_LAUNCH_EFFORT_UNPROVEN", layer });
  });
});

// ── CLAUDE_RENDER_LAYERS ──────────────────────────────────────────────────────────────────
// The render contracts refuse WITHOUT a layer by production design and spell their layer
// vocabulary on the accepted envelope's manifest. `refusedByManifestLayer` owes both halves and
// asserts the refusal really carries no layer, so a layer that starts being reported reddens.
describe("CLAUDE_RENDER_LAYERS", () => {
  const boundary = "CLAUDE_RENDER_LAYERS";
  const advisory = layerOf(CLAUDE_RENDER_LAYERS, "SKILLS_ADVISORY");
  const render = (overrides: Record<string, unknown> = {}): ReturnType<typeof renderClaudeContext> =>
    renderClaudeContext(hostile<RenderClaudeContextInput>(renderInput(overrides)));

  /** An advisory too large for the bound: the mandatory layers still fit, so the render
   *  SUCCEEDS and the advisory layer is the one excluded — a layer-attributed refusal. */
  const oversizedAdvisory = {
    skillSnapshot: skillSnapshot({
      skills: [
        {
          skillId: "hostile",
          files: [
            {
              path: "big.md",
              sha256: POISON_DIGEST,
              byteLength: 8_192,
              contentBase64: Buffer.alloc(8_192, 0x61).toString("base64"),
            },
          ],
        },
      ],
    }),
  };

  it("BEFORE — a skill snapshot claiming authority is refused, never sanitised", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => render({ skillSnapshot: skillSnapshot({ authority: "PROVEN" }) }),
      async () => render(oversizedAdvisory),
    );
    refusedWithoutLayer(
      ledger, boundary, "BEFORE", outcome.probe, "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
    );
    // The layer vocabulary IS exercised on this boundary: the oversized advisory excludes its
    // own layer, and both the code and the layer below are read off the production manifest.
    refusedByManifestLayer(ledger, boundary, "BEFORE", advisoryEntry(outcome.effect), advisory);
  });

  it("AFTER — an unsupported renderer input version is refused before any byte is framed", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => render({ skillSnapshot: skillSnapshot({ rendererInputVersion: "forged/9" }) }),
      async () => render({ taskContext: { taskRef: "", bodyBytes: Buffer.alloc(0) } }),
    );
    // Version is checked BEFORE the advisory/task gates, so the first fixture provably could
    // not have been answered by either of them.
    refusedWithoutLayer(
      ledger, boundary, "AFTER", outcome.effect, "CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
    );
    refusedWithoutLayer(
      ledger, boundary, "AFTER", outcome.probe, "CLAUDE_RENDER_TASK_CONTEXT_INVALID",
    );
  });

  it("RACE — an unbounded advisory and an unknowable context limit are both refused", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => render({ contextLimit: { kind: "EXACT_TOKENS", tokens: 10 }, tokenizer: null }),
      async () => render(oversizedAdvisory),
    );
    expect(outcome.left.status).toBe("fulfilled");
    refusedWithoutLayer(
      ledger,
      boundary,
      "RACE",
      (outcome.left as { value: unknown }).value,
      "CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN",
    );
    refusedByManifestLayer(
      ledger,
      boundary,
      "RACE",
      advisoryEntry((outcome.right as { value: never }).value),
      advisory,
    );
  });
});

// ── CODEX_RENDER_LAYERS ───────────────────────────────────────────────────────────────────
// The second provider's renderer, asserted INDEPENDENTLY: it does not delegate to the Claude
// one, so a codex refusal carrying a claude code would be an inherited judgement.
describe("CODEX_RENDER_LAYERS", () => {
  const boundary = "CODEX_RENDER_LAYERS";
  const advisory = layerOf(CODEX_RENDER_LAYERS, "SKILLS_ADVISORY");
  const render = (overrides: Record<string, unknown> = {}): ReturnType<typeof renderCodexContext> =>
    renderCodexContext(hostile<RenderCodexContextInput>(renderInput(overrides)));
  const huge = {
    skillSnapshot: skillSnapshot({
      skills: [
        {
          skillId: "hostile",
          files: [
            {
              path: "big.md",
              sha256: POISON_DIGEST,
              byteLength: 8_192,
              contentBase64: Buffer.alloc(8_192, 0x61).toString("base64"),
            },
          ],
        },
      ],
    }),
  };

  it("BEFORE — an oversized advisory excludes ITS OWN layer and never gains authority", async () => {
    const outcome = await probeBefore(BOUND, async () => render(huge), async () => render(huge));
    for (const observed of [outcome.probe, outcome.effect]) {
      expect((observed as { rendered?: { authority: string } }).rendered?.authority).toBe("NONE");
      refusedByManifestLayer(ledger, boundary, "BEFORE", advisoryEntry(observed), advisory);
    }
  });

  it("AFTER — mandatory context past the bound is refused outright, with no envelope at all", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => render({ contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 1 } }),
      async () => render({ contextLimit: { kind: "EXACT_TOKENS", tokens: 4 }, tokenizer: null }),
    );
    refusedWithoutLayer(ledger, boundary, "AFTER", outcome.effect, "CODEX_RENDER_CONTEXT_TOO_LARGE");
    refusedWithoutLayer(
      ledger, boundary, "AFTER", outcome.probe, "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN",
    );
  });

  it("RACE — a forged snapshot and an oversized advisory contend; neither is admitted", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => render({ skillSnapshot: skillSnapshot({ advisoryOnly: false }) }),
      async () => render(huge),
    );
    refusedWithoutLayer(
      ledger,
      boundary,
      "RACE",
      (outcome.left as { value: unknown }).value,
      "CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
    );
    refusedByManifestLayer(
      ledger,
      boundary,
      "RACE",
      advisoryEntry((outcome.right as { value: never }).value),
      advisory,
    );
  });
});

// ── PROVIDER_USAGE_LAYERS ─────────────────────────────────────────────────────────────────
// The measurement seam. An unobserved interval, sequence or receipt is REFUSED rather than
// substituted: a placeholder would be an invented value gaining authority.
describe("PROVIDER_USAGE_LAYERS", () => {
  const boundary = "PROVIDER_USAGE_LAYERS";
  const handoff = (overrides: Record<string, unknown>): ClaudeTelemetryHandoff =>
    hostile<ClaudeTelemetryHandoff>({
      launch: { startedAt: "2026-08-16T00:00:00.000Z", completedAt: "2026-08-16T00:00:01.000Z" },
      sequence: { known: true, value: 1 },
      stdoutReceiptDigest: { known: true, value: POISON_DIGEST },
      providerRunRef: REF,
      tokens: {},
      telemetryRefusal: null,
      ...overrides,
    });

  it("BEFORE — an unobserved interval refuses at USAGE_INPUT rather than substituting one", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => normalizeProviderUsage(handoff({ launch: { startedAt: null, completedAt: null } }), { priors: [] }),
      async () =>
        normalizeProviderUsage(
          handoff({ launch: { startedAt: "2026-08-16T00:00:00.000Z", completedAt: null } }),
          { priors: [] },
        ),
    );
    const unobserved = { code: "PROVIDER_USAGE_INTERVAL_UNOBSERVED", layer: USAGE_INPUT };
    ledger.refused(boundary, "BEFORE", outcome.probe, unobserved);
    ledger.refused(boundary, "BEFORE", outcome.effect, unobserved);
  });

  it("AFTER — an unknown sequence and an unknown receipt keep DISTINCT codes", async () => {
    const outcome = await probeAfter(
      BOUND,
      // The interval is observed, so the arm above provably cannot answer.
      async () => normalizeProviderUsage(handoff({ sequence: { known: false } }), { priors: [] }),
      async () =>
        normalizeProviderUsage(handoff({ stdoutReceiptDigest: { known: false } }), { priors: [] }),
    );
    ledger.refused(boundary, "AFTER", outcome.effect, {
      code: "PROVIDER_USAGE_SEQUENCE_UNKNOWN",
      layer: USAGE_INPUT,
    });
    ledger.refused(boundary, "AFTER", outcome.probe, {
      code: "PROVIDER_USAGE_RECEIPT_UNKNOWN",
      layer: USAGE_INPUT,
    });
  });

  it("RACE — a forged prior and an unknown sequence contend; no measurement is minted", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () =>
        normalizeProviderUsage(handoff({}), { priors: hostile([{ meter: "forged", value: 1 }]) }),
      async () => normalizeProviderUsage(handoff({ sequence: { known: false } }), { priors: [] }),
    );
    ledger.refusedSide(boundary, outcome.left, {
      code: "PROVIDER_USAGE_PRIOR_UNREADABLE",
      layer: USAGE_INPUT,
    });
    ledger.refusedSide(boundary, outcome.right, {
      code: "PROVIDER_USAGE_SEQUENCE_UNKNOWN",
      layer: USAGE_INPUT,
    });
  });
});

// ── PROVIDER_RUN_LEDGER_LAYERS ────────────────────────────────────────────────────────────
// The daemon's provider-run codec. Its four layers name the stage that refused, so a codec
// fault can never read as a ledger fault.
describe("PROVIDER_RUN_LEDGER_LAYERS", () => {
  const boundary = "PROVIDER_RUN_LEDGER_LAYERS";
  const malformed = { code: "PROVIDER_RUN_RECORD_MALFORMED", layer: CODEC };

  it("BEFORE — a record that is not exact bounded plain data cannot be encoded", async () => {
    const outcome = await probeBefore(
      BOUND,
      async () => encodeProviderRunRecord(null),
      async () => encodeProviderRunRecord({ forged: POISON_PATH }),
    );
    ledger.refused(boundary, "BEFORE", outcome.probe, malformed);
    ledger.refused(boundary, "BEFORE", outcome.effect, malformed);
  });

  it("AFTER — bytes that do not decode back are refused, never partially admitted", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => decodeProviderRunRecord(hostile<unknown>(Uint8Array.from([0x7b, 0x00]))),
      async () => decodeProviderRunRecord("not-a-record"),
    );
    const unreadable = { code: "PROVIDER_RUN_RECORD_UNREADABLE", layer: CODEC };
    ledger.refused(boundary, "AFTER", outcome.effect, unreadable);
    ledger.refused(boundary, "AFTER", outcome.probe, unreadable);
  });

  it("RACE — a refusal minted for one layer never reports another's", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => encodeProviderRunRecord(hostile<unknown>([])),
      async () => providerRunRefusal("PROVIDER_RUN_DIGEST_MISMATCH", "PROVIDER_RUN_CODEC"),
    );
    ledger.refusedSide(boundary, outcome.left, malformed);
    ledger.refusedSide(boundary, outcome.right, {
      code: "PROVIDER_RUN_DIGEST_MISMATCH",
      layer: CODEC,
    });
  });
});

describeSliceInvariants("provider launch group", ledger, OWNED, LAUNCH_SECRETS);

// The two blind handoff shapes, pinned as DISTINCT. Registered here rather than folded into a
// boundary block because it is the trap this whole file is built around: nothing branches on
// `ok`, and collapsing the two shapes would lose which of them happened.
describe("provider launch group — the blind-handoff trap", () => {
  it("keeps TELEMETRY_LAUNCH_REFUSED and TELEMETRY_LAUNCH_NOT_ATTEMPTED distinguishable", () => {
    expect(AMBIGUOUS_STREAM).toContain("claude-b");
    expect(OUT_OF_ORDER_STREAM.indexOf("result")).toBeLessThan(OUT_OF_ORDER_STREAM.indexOf("init"));
    const refusals = ledger.entries.filter((entry) => entry.boundary === "PROVIDER_TELEMETRY_LAYERS");
    expect(refusals.length).toBeGreaterThan(0);
    // No telemetry refusal here reports a terminal outcome, so none of them upgraded a
    // truth class on the strength of provider bytes.
    expect(refusals.filter((entry) => entry.admitted)).toEqual([]);
  });
});
