/**
 * THE RENDER BOUNDARY CASES, registered from one parameterised builder.
 *
 * NOT a `*.security.ts` file: it registers its suites into the slice that calls it, exactly as
 * `describeSliceInvariants` does, so the cases run inside `runtime-provider-launch.security.ts`
 * and are counted there. Splitting them out is the 400-line rail, not a scope decision.
 *
 * WHY ONE BUILDER FOR TWO BOUNDARIES. `CLAUDE_RENDER_LAYERS` and `CODEX_RENDER_LAYERS` have the
 * same case structure, and a copy would let the two drift. The codex arm is still provably its
 * OWN judgement rather than an inherited claude one, because every code and the layer constant
 * are supplied by the caller from that renderer's own exported vocabulary — a codex refusal
 * answering with a claude code reddens here.
 *
 * BOTH RENDERERS REFUSE WITHOUT A LAYER by production design: `claudeFailure`/`codexFailure`
 * return `{ok, code, message}` and the layer vocabulary lives on the ACCEPTED envelope's
 * manifest. So each boundary gets both halves — `refusedWithoutLayer` for the outright
 * refusals, whose layer-absence is asserted rather than assumed, and `refusedByManifestLayer`
 * for the excluded advisory layer, whose code and layer are both read off production.
 */

import { describe, expect, it } from "vitest";

import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  OVERSIZED_SKILL,
  refusedByManifestLayer,
  refusedWithoutLayer,
  skillSnapshot,
} from "./runtime-provider-launch-fixtures.js";
import { RUNTIME_BOUND as BOUND } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";

export interface RenderBoundarySpec {
  readonly boundary: string;
  /** Taken from the renderer's OWN `*_RENDER_LAYERS` constant by the caller. */
  readonly advisory: string;
  readonly render: (overrides: Record<string, unknown>) => unknown;
  readonly notAdvisory: string;
  readonly versionUnsupported: string;
  readonly taskInvalid: string;
  readonly tooLarge: string;
  readonly limitUnknown: string;
}

/** An advisory too large for the bound. The mandatory layers still fit, so the render SUCCEEDS
 *  and the advisory layer is the one EXCLUDED — production's own layer-attributed refusal. */
const OVERSIZED = { skillSnapshot: skillSnapshot({ skills: [OVERSIZED_SKILL] }) };

/** The excluded SKILLS_ADVISORY entry off a production manifest. */
const advisoryEntry = (result: unknown): unknown =>
  (result as { rendered?: { layerManifest?: readonly unknown[] } }).rendered?.layerManifest?.find(
    (entry) => (entry as { layer?: string }).layer === "SKILLS_ADVISORY",
  );

export function describeRenderBoundary(ledger: Ledger, spec: RenderBoundarySpec): void {
  const { boundary, advisory, render } = spec;

  describe(boundary, () => {
    it("BEFORE — a snapshot claiming authority is refused, and an oversized one is excluded", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => render({ skillSnapshot: skillSnapshot({ authority: "PROVEN" }) }),
        async () => render(OVERSIZED),
      );
      refusedWithoutLayer(ledger, boundary, "BEFORE", outcome.probe, spec.notAdvisory);
      // The layer vocabulary IS exercised: both the code and the layer below come off the
      // production manifest, so this cannot pass by tautology.
      expect((outcome.effect as { rendered?: { authority: string } }).rendered?.authority).toBe("NONE");
      refusedByManifestLayer(ledger, boundary, "BEFORE", advisoryEntry(outcome.effect), advisory);
    });

    it("AFTER — an unsupported renderer input version is refused before any byte is framed", async () => {
      const outcome = await probeAfter(
        BOUND,
        async () => render({ skillSnapshot: skillSnapshot({ rendererInputVersion: "forged/9" }) }),
        async () => render({ taskContext: { taskRef: "", bodyBytes: Buffer.alloc(0) } }),
      );
      // Version is checked BEFORE the advisory and task gates, so neither could have answered
      // the first fixture; the second is version-valid, so the task gate provably answered it.
      refusedWithoutLayer(ledger, boundary, "AFTER", outcome.effect, spec.versionUnsupported);
      refusedWithoutLayer(ledger, boundary, "AFTER", outcome.probe, spec.taskInvalid);
    });

    it("AFTER — mandatory context past the bound is refused outright, with no envelope at all", async () => {
      const outcome = await probeAfter(
        BOUND,
        async () => render({ contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 1 } }),
        async () => render({ contextLimit: { kind: "EXACT_TOKENS", tokens: 4 }, tokenizer: null }),
      );
      refusedWithoutLayer(ledger, boundary, "AFTER", outcome.effect, spec.tooLarge);
      refusedWithoutLayer(ledger, boundary, "AFTER", outcome.probe, spec.limitUnknown);
    });

    it("RACE — an unknowable bound and an oversized advisory contend; neither is admitted", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => render({ contextLimit: { kind: "EXACT_TOKENS", tokens: 10 }, tokenizer: null }),
        async () => render(OVERSIZED),
      );
      expect(outcome.left.status).toBe("fulfilled");
      expect(outcome.right.status).toBe("fulfilled");
      refusedWithoutLayer(
        ledger,
        boundary,
        "RACE",
        (outcome.left as { value: unknown }).value,
        spec.limitUnknown,
      );
      refusedByManifestLayer(
        ledger,
        boundary,
        "RACE",
        advisoryEntry((outcome.right as { value: unknown }).value),
        advisory,
      );
    });
  });
}
