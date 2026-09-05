import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { GOAL_PREREQUISITE_LAYER } from "../goals/goal-close-prerequisite.js";
import { PROJECT_REDUCER_LAYER } from "../recovery/recovery-completion-evidence.js";
import { RUNNER_WORKSPACE_LAYER } from "../work/foundation-attempt-contracts.js";

import {
  RELEASE_DECIDE_CODE_LAYER_MAP,
  RELEASE_DECIDE_CODES,
  RELEASE_DECIDE_COMMAND_KIND,
  isReleaseDecideRefusal,
  releaseRefusal,
  type ReleaseDecideCode,
  type ReleaseDecideRefusal,
} from "./release-decide-contracts.js";

describe("release.decide refusal vocabulary", () => {
  /**
   * DoD-3's arm. Per code, BOTH the stable code AND the layer it resolves to — never merely
   * that something was refused. The layer is half the contract: a refusal that names the
   * wrong layer sends an operator to the wrong surface.
   */
  it("resolves each code to its own layer, code and layer both pinned", () => {
    const remote = releaseRefusal("RELEASE_REMOTE_MISSING");
    expect(remote.code).toBe("RELEASE_REMOTE_MISSING");
    expect(remote.layer).toBe("PROJECT_REDUCER");

    const evidence = releaseRefusal("RELEASE_EVIDENCE_INCOMPLETE");
    expect(evidence.code).toBe("RELEASE_EVIDENCE_INCOMPLETE");
    expect(evidence.layer).toBe("DAEMON_PREREQUISITE");

    const pr = releaseRefusal("RELEASE_PR_FAILED");
    expect(pr.code).toBe("RELEASE_PR_FAILED");
    expect(pr.layer).toBe("RUNNER_WORKSPACE");
  });

  /**
   * The reuse is pinned BY IMPORT, not by a comment that can rot. If a rostered constant's
   * VALUE is ever changed, this arm reds here rather than silently letting this module drift
   * onto an unrostered layer string. Note GOAL_PREREQUISITE_LAYER's name and value differ —
   * the refusal carries the VALUE, which is what is asserted.
   */
  it("reuses the values of already-rostered layer constants, not bare literals", () => {
    expect(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_REMOTE_MISSING).toBe(PROJECT_REDUCER_LAYER);
    expect(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_EVIDENCE_INCOMPLETE).toBe(GOAL_PREREQUISITE_LAYER);
    expect(RELEASE_DECIDE_CODE_LAYER_MAP.RELEASE_PR_FAILED).toBe(RUNNER_WORKSPACE_LAYER);
  });

  /**
   * Bidirectional, per project rail 9. Asserting only `RELEASE_DECIDE_CODES` would iterate
   * the derived roster itself: deleting a map entry shrinks that iteration and the arm stays
   * green. So enumerate from the MAP as well and assert set-equality in both directions.
   */
  it("keeps the map closed and the roster derived, enumerated from both ends", () => {
    expect(RELEASE_DECIDE_CODES).toEqual([
      "RELEASE_EVIDENCE_INCOMPLETE",
      "RELEASE_PR_FAILED",
      "RELEASE_REMOTE_MISSING",
    ]);
    expect(new Set(Object.keys(RELEASE_DECIDE_CODE_LAYER_MAP))).toEqual(
      new Set(RELEASE_DECIDE_CODES),
    );
    expect(RELEASE_DECIDE_CODES).toHaveLength(3);
  });

  /** Every code the roster names resolves to a layer the map authorizes — no undefined pair. */
  it("mints an authorized layer for every code in the roster", () => {
    let checked = 0;
    for (const code of RELEASE_DECIDE_CODES) {
      const refusal = releaseRefusal(code);
      expect(refusal.layer).toBe(RELEASE_DECIDE_CODE_LAYER_MAP[code]);
      expect(refusal.ok).toBe(false);
      checked += 1;
    }
    // A sweep that silently yields zero cases would otherwise pass vacuously.
    expect(checked).toBe(3);
  });

  /**
   * The factory takes the CODE ONLY. A layer parameter would let a call site mint a
   * (code, layer) pair the map does not authorize — the disagreement must be inexpressible,
   * not merely discouraged. `detail` is defaulted, so it does not count toward `length`.
   */
  it("exposes no layer parameter on the refusal factory", () => {
    expect(releaseRefusal.length).toBe(1);
    expect(releaseRefusal("RELEASE_PR_FAILED", "gh exited 1").detail).toBe("gh exited 1");
    expect(releaseRefusal("RELEASE_PR_FAILED").detail).toBeNull();
  });

  /** The refusal is frozen: a caller cannot rewrite the layer after the factory set it. */
  it("freezes the minted refusal", () => {
    const refusal = releaseRefusal("RELEASE_REMOTE_MISSING");
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  /**
   * The (code, layer) correlation holds even for a call site that bypasses the factory and
   * hand-builds the object. `ReleaseDecideRefusal` is a per-code mapped type, not a loose
   * pair of independent unions, so the wrong layer is a COMPILE error.
   *
   * These arms are graded by `pnpm typecheck`, not by vitest — vitest strips types. If the
   * correlation were ever weakened back to `{code: ReleaseDecideCode; layer: ReleaseDecideLayer}`,
   * the `@ts-expect-error` directives would become unused and typecheck would red on them,
   * which is exactly the alarm wanted.
   */
  it("makes a disagreeing (code, layer) pair inexpressible, even without the factory", () => {
    const honest: ReleaseDecideRefusal = {
      code: "RELEASE_PR_FAILED",
      detail: null,
      layer: "RUNNER_WORKSPACE",
      ok: false,
    };
    expect(honest.layer).toBe("RUNNER_WORKSPACE");

    // @ts-expect-error RELEASE_PR_FAILED is mapped to RUNNER_WORKSPACE, never PROJECT_REDUCER.
    // The directive sits on the DECLARATION, not on the `layer` line: the assignability error
    // is reported against the initialised binding, so a directive on the property is unused.
    const disagreeing: ReleaseDecideRefusal = {
      code: "RELEASE_PR_FAILED",
      detail: null,
      layer: "PROJECT_REDUCER",
      ok: false,
    };
    // The value still exists at runtime; the point is that it did not compile cleanly.
    expect(disagreeing.code).toBe("RELEASE_PR_FAILED");
  });

  /** The one arm tying this module to the shared vocabulary edit. */
  it("names a kind that the runtime vocabulary actually carries", () => {
    expect(RELEASE_DECIDE_COMMAND_KIND).toBe("release.decide");
    expect(new Set<string>(RUNTIME_COMMAND_KINDS).has(RELEASE_DECIDE_COMMAND_KIND)).toBe(true);
  });

  describe("isReleaseDecideRefusal", () => {
    it("admits a minted refusal", () => {
      for (const code of RELEASE_DECIDE_CODES) {
        expect(isReleaseDecideRefusal(releaseRefusal(code))).toBe(true);
      }
    });

    it("rejects non-refusals", () => {
      expect(isReleaseDecideRefusal(null)).toBe(false);
      expect(isReleaseDecideRefusal(undefined)).toBe(false);
      expect(isReleaseDecideRefusal({})).toBe(false);
      expect(isReleaseDecideRefusal({ ok: true })).toBe(false);
      expect(isReleaseDecideRefusal("RELEASE_PR_FAILED")).toBe(false);
    });

    /**
     * A refusal from ANOTHER vocabulary is not one of ours. The guard checks the code against
     * the closed roster, so `ok === false` alone does not admit a foreign code.
     */
    it("rejects a foreign refusal that merely carries ok:false", () => {
      expect(isReleaseDecideRefusal({ code: "PREVIEW_DECISION_INVALID", ok: false })).toBe(false);
      expect(isReleaseDecideRefusal({ ok: false })).toBe(false);
    });

    it("does not admit a code inherited from the prototype chain", () => {
      const inherited = Object.create({ code: "RELEASE_PR_FAILED" }) as { ok?: unknown };
      inherited.ok = false;
      expect(isReleaseDecideRefusal(inherited)).toBe(false);
    });
  });

  /** The roster is the compile-time code set too, so a typo cannot reach the factory. */
  it("keeps the derived code type aligned with the map keys", () => {
    const codes: readonly ReleaseDecideCode[] = RELEASE_DECIDE_CODES;
    expect(codes.every((code) => code in RELEASE_DECIDE_CODE_LAYER_MAP)).toBe(true);
  });
});
