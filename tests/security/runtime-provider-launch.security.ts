/**
 * HOSTILE COVERAGE — the PROVIDER LAUNCH, RENDER, TELEMETRY AND USAGE group of the
 * runtime-provider axis. Eight of the roster's thirty-one entries; the partition is declared in
 * `runtime-provider-invariants.ts` and its union is checked against the roster in the evidence file.
 *
 * THE TRAP THAT WOULD OTHERWISE MAKE HALF THIS FILE VACUOUS, measured at
 * `claude-telemetry-launch.ts:206`: `launchClaudeWithTelemetry` returns `ok: true` for a launcher
 * that REFUSED and for a delivery that was NOT ATTEMPTED, both carrying a BLIND handoff whose
 * facts are UNKNOWN; the ONLY route to `ok: false` is a malformed run ref. Nothing here branches
 * on `ok` — the cases assert `telemetryRefusal`, `terminal` and `infrastructure`, and pin
 * `TELEMETRY_LAUNCH_REFUSED` and `TELEMETRY_LAUNCH_NOT_ATTEMPTED` as DISTINCT shapes.
 *
 * FIVE LAYERS CAN ANSWER the telemetry seam, and the contract's own comment says a code-only
 * assertion "would stay green once a different layer started answering first". Every stream
 * fixture is COHERENT at input, capture and the anomaly analyser and breaks exactly one thing, so
 * the arranged layer is provably the one that answered. NO TEST PRINTS PROVIDER OUTPUT: poisoned
 * bytes are never logged, and hygiene is a property over the WHOLE refusal set, not one example.
 */

import { describe, expect, it } from "vitest";

import { PROVIDER_RUN_LEDGER_LAYERS, providerRunUnknown } from "../../apps/daemon/src/telemetry/provider-run-refusals.js";
import { decodeProviderRunRecord, encodeProviderRunRecord } from "../../apps/daemon/src/telemetry/provider-run-codec.js";
import { launchClaude } from "../../packages/runner/src/providers/claude/claude-launcher.js";
import { CLAUDE_LAUNCH_LAYERS, CLAUDE_LAUNCH_SELECTION_LAYER } from "../../packages/runner/src/providers/claude/claude-launcher-contract.js";
import { verifyLaunchSelection } from "../../packages/runner/src/providers/claude/claude-launch-verify.js";
import { CLAUDE_RENDER_LAYERS, renderClaudeContext } from "../../packages/runner/src/providers/claude/claude-render.js";
import type { RenderClaudeContextInput } from "../../packages/runner/src/providers/claude/claude-render.js";
import { CODEX_RENDER_LAYERS, renderCodexContext } from "../../packages/runner/src/providers/codex/codex-render.js";
import type { RenderCodexContextInput } from "../../packages/runner/src/providers/codex/codex-render.js";
import { parseClaudeResultTelemetry } from "../../packages/runner/src/providers/telemetry/claude-result-telemetry.js";
import { launchClaudeWithTelemetry } from "../../packages/runner/src/providers/telemetry/claude-telemetry-launch.js";
import { PROVIDER_TELEMETRY_CODES, PROVIDER_TELEMETRY_LAYERS, PROVIDER_TELEMETRY_MESSAGES } from "../../packages/runner/src/providers/telemetry/provider-telemetry-contracts.js";
import { PROVIDER_USAGE_LAYERS } from "../../packages/runner/src/providers/telemetry/provider-usage-contracts.js";
import { normalizeProviderUsage } from "../../packages/runner/src/providers/telemetry/provider-usage-normalization.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { describeBenchmarkProjectionBoundary } from "./runtime-provider-benchmark-cases.js";
import { describeRenderBoundary } from "./runtime-provider-render-cases.js";
import {
  AMBIGUOUS_STREAM, COHERENT_STREAM, GOOD_RUN_REF as REF, GOOD_SELECTION, LAUNCH_SECRETS,
  OUT_OF_ORDER_STREAM, POISON_DIGEST, POISON_PATH, RESUMED_STREAM, UNSUPPORTED_SCHEMA_STREAM,
  capture, refusedTelemetry, renderInput, usageHandoff as handoff,
} from "./runtime-provider-launch-fixtures.js";
import {
  RUNTIME_BOUND as BOUND, RUNTIME_PROVIDER_PARTITION, createLedger, describeSliceInvariants,
  hostile, layerOf,
} from "./runtime-provider-ledger.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.LAUNCH;
const ledger = createLedger();

const CAPTURE = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_CAPTURE");
const INPUT = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_INPUT");
const SCHEMA = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_SCHEMA");
const RESULT = layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_RESULT");
const USAGE_INPUT = layerOf(PROVIDER_USAGE_LAYERS, "USAGE_INPUT");
const CODEC = layerOf(PROVIDER_RUN_LEDGER_LAYERS, "PROVIDER_RUN_CODEC");
const LAUNCHER = layerOf(CLAUDE_LAUNCH_LAYERS, "LAUNCHER");

const parse = (stdout: unknown, providerRunRef: unknown = REF): unknown =>
  parseClaudeResultTelemetry(hostile({ providerRunRef, stdout }));

// ── PROVIDER_TELEMETRY_LAYERS ─────────────────────────────────────────────────────────────
// Poisoned provider output. Every fixture is a COHERENT capture with exactly one thing broken,
// so the layer named below is provably the one that answered rather than an earlier one.
describe("PROVIDER_TELEMETRY_LAYERS", () => {
  const boundary = "PROVIDER_TELEMETRY_LAYERS";

  it("BEFORE — bytes that do not decode to their declared digest are refused at CAPTURE", async () => {
    const good = capture(COHERENT_STREAM);
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
    const good = capture(COHERENT_STREAM);
    const outcome = await probeAfter(
      BOUND,
      async () => parse({ ...good, truncated: true }),
      async () => parse({ ...good, complete: false }),
    );
    // Two branches at ONE layer: pinned separately so neither could answer for the other.
    refusedTelemetry(ledger, boundary, "AFTER", outcome.effect, "TELEMETRY_CAPTURE_TRUNCATED", CAPTURE);
    refusedTelemetry(ledger, boundary, "AFTER", outcome.probe, "TELEMETRY_CAPTURE_INCOMPLETE", CAPTURE);
  });

  it("AFTER — disagreeing and interleaved records never resolve into an admitted model", async () => {
    const outcome = await probeAfter(
      BOUND,
      // Both captures are coherent at INPUT and CAPTURE, so neither can answer here.
      async () => parse(capture(AMBIGUOUS_STREAM)),
      async () => parse(capture(OUT_OF_ORDER_STREAM)),
    );
    // The ambiguous stream PARSES. That is the point: provider output is admitted as bytes and
    // still confers nothing — the model fact stays UNKNOWN with its own code and layer rather
    // than one of the two disagreeing records being picked as authority.
    const parsed = outcome.effect as { ok: boolean; telemetry: { observedModel: { modelId: unknown } } };
    expect(parsed.ok).toBe(true);
    refusedTelemetry(
      ledger, boundary, "AFTER", parsed.telemetry.observedModel.modelId,
      "TELEMETRY_MODEL_AMBIGUOUS", RESULT,
    );
    refusedTelemetry(
      ledger, boundary, "AFTER", outcome.probe, "TELEMETRY_STREAM_ANOMALOUS", SCHEMA,
    );
  });

  it("AFTER — a record resuming a session this capture never held is refused as anomalous", async () => {
    const outcome = await probeAfter(
      BOUND,
      async () => parse(capture(RESUMED_STREAM)),
      async () => parse(capture(UNSUPPORTED_SCHEMA_STREAM)),
    );
    // Same layer, DISTINCT codes: a resume discontinuity is not an unsupported schema, and
    // pinning them together would let either answer for the other.
    refusedTelemetry(ledger, boundary, "AFTER", outcome.effect, "TELEMETRY_STREAM_ANOMALOUS", SCHEMA);
    refusedTelemetry(ledger, boundary, "AFTER", outcome.probe, "TELEMETRY_SCHEMA_UNSUPPORTED", SCHEMA);
  });

  it("RACE — a malformed run ref and an unsupported schema answer at DIFFERENT layers", async () => {
    const outcome = await probeRacing(
      BOUND,
      // Capture coherent, ref hostile: TELEMETRY_INPUT is arranged to answer.
      async () => parse(capture(COHERENT_STREAM), { runRef: 1 }),
      async () => parse(capture(UNSUPPORTED_SCHEMA_STREAM)),
    );
    ledger.refusedSide(boundary, outcome.left, { code: "TELEMETRY_RUN_REF_MALFORMED", layer: INPUT });
    ledger.refusedSide(boundary, outcome.right, {
      code: "TELEMETRY_SCHEMA_UNSUPPORTED", layer: SCHEMA,
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

  it("AFTER — a reflection trap is CONTAINED, and no trap ever runs", async () => {
    let ran = false;
    const trap = {
      get argv(): never {
        ran = true;
        throw new Error("reflection must not run");
      },
    };
    const outcome = await probeAfter(
      BOUND,
      async () => await launchClaude(hostile(trap)),
      async () => await launchClaude(hostile(new Proxy({}, {}))),
    );
    // A trap that HAS run has already had its effect whatever the guard decides afterwards, so
    // containment is asserted by the accessor never firing, not by the refusal alone.
    expect(ran).toBe(false);
    // Both answer as the launcher's own malformed request. The other members of this composed
    // vocabulary — CLAUDE_LAUNCH_SELECTION_LAYER, CLAUDE_RUNTIME_PIN_LAYER and the
    // WINDOWS_PROCESS_LAYERS — are separate roster entries with their own blocks, so pinning
    // LAUNCHER here does not leave them unexercised.
    ledger.refused(boundary, "AFTER", outcome.effect, malformed);
    ledger.refused(boundary, "AFTER", outcome.probe, malformed);
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
  const selection = GOOD_SELECTION;

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

// ── CLAUDE_RENDER_LAYERS AND CODEX_RENDER_LAYERS ──────────────────────────────────────────
// Both renderers refuse WITHOUT a layer by production design and spell their layer vocabulary
// on the accepted envelope's manifest instead. The two blocks are registered from ONE
// parameterised builder because their case structure is identical — a copy would let the two
// drift, and the codex arm must be provably its own rather than an inherited claude judgement,
// which the builder guarantees by taking each renderer's OWN codes and layer constant.
describeRenderBoundary(ledger, {
  boundary: "CLAUDE_RENDER_LAYERS",
  advisory: layerOf(CLAUDE_RENDER_LAYERS, "SKILLS_ADVISORY"),
  render: (overrides) => renderClaudeContext(hostile<RenderClaudeContextInput>(renderInput(overrides))),
  notAdvisory: "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
  versionUnsupported: "CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
  taskInvalid: "CLAUDE_RENDER_TASK_CONTEXT_INVALID",
  tooLarge: "CLAUDE_RENDER_CONTEXT_TOO_LARGE",
  limitUnknown: "CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN",
});

describeRenderBoundary(ledger, {
  boundary: "CODEX_RENDER_LAYERS",
  advisory: layerOf(CODEX_RENDER_LAYERS, "SKILLS_ADVISORY"),
  render: (overrides) => renderCodexContext(hostile<RenderCodexContextInput>(renderInput(overrides))),
  notAdvisory: "CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
  versionUnsupported: "CODEX_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
  taskInvalid: "CODEX_RENDER_TASK_CONTEXT_INVALID",
  tooLarge: "CODEX_RENDER_CONTEXT_TOO_LARGE",
  limitUnknown: "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN",
});

// ── PROVIDER_USAGE_LAYERS ─────────────────────────────────────────────────────────────────
// The measurement seam. An unobserved interval, sequence or receipt is REFUSED rather than
// substituted: a placeholder would be an invented value gaining authority.
describe("PROVIDER_USAGE_LAYERS", () => {
  const boundary = "PROVIDER_USAGE_LAYERS";
  const sequenceUnknown = { code: "PROVIDER_USAGE_SEQUENCE_UNKNOWN", layer: USAGE_INPUT };
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
    ledger.refused(boundary, "AFTER", outcome.effect, sequenceUnknown);
    ledger.refused(boundary, "AFTER", outcome.probe, {
      code: "PROVIDER_USAGE_RECEIPT_UNKNOWN", layer: USAGE_INPUT,
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
      code: "PROVIDER_USAGE_PRIOR_UNREADABLE", layer: USAGE_INPUT,
    });
    ledger.refusedSide(boundary, outcome.right, sequenceUnknown);
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
    const unreadable = { code: "PROVIDER_RUN_BYTES_MALFORMED", layer: CODEC };
    ledger.refused(boundary, "AFTER", outcome.effect, unreadable);
    ledger.refused(boundary, "AFTER", outcome.probe, unreadable);
  });

  it("RACE — a refusal minted for one layer never reports another's", async () => {
    const outcome = await probeRacing(
      BOUND,
      async () => encodeProviderRunRecord(hostile<unknown>([])),
      async () => providerRunUnknown("PROVIDER_RUN_DIGEST_MISMATCH", "PROVIDER_RUN_CODEC"),
    );
    ledger.refusedSide(boundary, outcome.left, malformed);
    ledger.refusedSide(boundary, outcome.right, {
      code: "PROVIDER_RUN_DIGEST_MISMATCH", layer: CODEC,
    });
  });
});

// ── THE BLIND-HANDOFF TRAP ────────────────────────────────────────────────────────────────
// The defining trap of this axis, driven through the REAL seam. `launchClaudeWithTelemetry`
// answers `ok: true` for a launcher that REFUSED, so nothing below branches on `ok`.
describe("provider launch group — the blind-handoff trap", () => {
  const boundary = "PROVIDER_TELEMETRY_LAYERS";

  it("reports a REFUSED launch as ok:true with blind UNKNOWN facts, never as a failure", async () => {
    const result = await launchClaudeWithTelemetry(
      hostile({ providerRunRef: REF, request: null }),
    );
    // THE TRAP: a case asserting `ok === false` here would never fire.
    expect(result.ok).toBe(true);
    const handoff = (result as unknown as { handoff: Record<string, unknown> }).handoff;
    expect(handoff["terminal"]).toBe("REFUSED");
    expect(handoff["infrastructure"]).toBe("LAUNCH_REFUSED");
    // Nothing was observed, so no fact may claim to be known.
    expect((handoff["sequence"] as { known: boolean }).known).toBe(false);
    ledger.refused(boundary, "AFTER", handoff["telemetryRefusal"], {
      code: "TELEMETRY_LAUNCH_REFUSED", layer: layerOf(PROVIDER_TELEMETRY_LAYERS, "TELEMETRY_LAUNCH"),
    });
  });

  it("keeps the two blind shapes DISTINCT members of the vocabulary, never collapsed", () => {
    expect(PROVIDER_TELEMETRY_CODES as readonly string[]).toContain("TELEMETRY_LAUNCH_REFUSED");
    expect(PROVIDER_TELEMETRY_CODES as readonly string[]).toContain("TELEMETRY_LAUNCH_NOT_ATTEMPTED");
    expect(PROVIDER_TELEMETRY_MESSAGES.TELEMETRY_LAUNCH_REFUSED).not.toBe(
      PROVIDER_TELEMETRY_MESSAGES.TELEMETRY_LAUNCH_NOT_ATTEMPTED,
    );
  });

  it("refuses a malformed run ref BEFORE any launch, the one route to ok:false", async () => {
    const result = await launchClaudeWithTelemetry(hostile({ providerRunRef: 1, request: null }));
    expect(result.ok).toBe(false);
    ledger.refused(boundary, "BEFORE", result, { code: "TELEMETRY_RUN_REF_MALFORMED", layer: INPUT });
  });
});

describeBenchmarkProjectionBoundary(ledger);
describeSliceInvariants("provider launch group", ledger, OWNED, LAUNCH_SECRETS, 6);
