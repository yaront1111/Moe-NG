import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { GOAL_PREREQUISITE_LAYER } from "../goals/goal-close-prerequisite.js";
import { REPOSITORY_DELIVERY_LAYER } from "../orchestrator/repository-delivery-contracts.js";
import { PROJECT_REDUCER_LAYER } from "../recovery/recovery-completion-evidence.js";
import { RUNNER_WORKSPACE_LAYER } from "../work/foundation-attempt-contracts.js";

import {
  ENV_EXAMPLE_SYNC_CODE_LAYER_MAP,
  ENV_EXAMPLE_SYNC_CODES,
  ENV_EXAMPLE_SYNC_COMMAND_KIND,
  envExampleSyncRefusal,
  isEnvExampleSyncRefusal,
  type EnvExampleSyncCode,
  type EnvExampleSyncRefusal,
} from "./env-example-sync-contracts.js";

describe("product_contract.sync_env_example refusal vocabulary", () => {
  /**
   * (A) Per code, BOTH the stable code AND the layer it resolves to — never merely that
   * something was refused. The layer is half the contract: a refusal naming the wrong layer
   * sends an operator to the wrong surface, and the map is decorative unless this arm exists.
   */
  it("resolves each code to its own layer, code and layer both pinned", () => {
    const unapproved = envExampleSyncRefusal("ENV_EXAMPLE_CONTRACT_UNAPPROVED");
    expect(unapproved.code).toBe("ENV_EXAMPLE_CONTRACT_UNAPPROVED");
    expect(unapproved.layer).toBe("DAEMON_PREREQUISITE");

    const unbound = envExampleSyncRefusal("ENV_EXAMPLE_REPOSITORY_UNBOUND");
    expect(unbound.code).toBe("ENV_EXAMPLE_REPOSITORY_UNBOUND");
    expect(unbound.layer).toBe("PROJECT_REDUCER");

    const unreadable = envExampleSyncRefusal("ENV_EXAMPLE_REPOSITORY_UNREADABLE");
    expect(unreadable.code).toBe("ENV_EXAMPLE_REPOSITORY_UNREADABLE");
    expect(unreadable.layer).toBe("RUNNER_WORKSPACE");

    const commit = envExampleSyncRefusal("ENV_EXAMPLE_COMMIT_FAILED");
    expect(commit.code).toBe("ENV_EXAMPLE_COMMIT_FAILED");
    expect(commit.layer).toBe("REPOSITORY_DELIVERY");
  });

  /**
   * (D) The reuse is pinned BY IMPORT, not by a comment that can rot. A bare layer literal is
   * invisible to `tests/security/boundary-roster.security.ts`, so if a rostered constant's
   * VALUE ever changes, this arm reds here rather than letting the module drift onto an
   * unrostered string. Note the constant NAMES and their VALUES differ (GOAL_PREREQUISITE_LAYER
   * is "DAEMON_PREREQUISITE"); the refusal carries the VALUE, which is what is asserted.
   */
  it("reuses the values of already-rostered layer constants, not bare literals", () => {
    expect(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP.ENV_EXAMPLE_CONTRACT_UNAPPROVED)
      .toBe(GOAL_PREREQUISITE_LAYER);
    expect(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP.ENV_EXAMPLE_REPOSITORY_UNBOUND)
      .toBe(PROJECT_REDUCER_LAYER);
    expect(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP.ENV_EXAMPLE_REPOSITORY_UNREADABLE)
      .toBe(RUNNER_WORKSPACE_LAYER);
    expect(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP.ENV_EXAMPLE_COMMIT_FAILED)
      .toBe(REPOSITORY_DELIVERY_LAYER);
  });

  /**
   * (B) Bidirectional, per project rail 9. Asserting only `ENV_EXAMPLE_SYNC_CODES` would
   * iterate the derived roster itself: deleting a map entry shrinks that iteration and the arm
   * stays green. So enumerate from the MAP as well and assert set-equality in both directions.
   */
  it("keeps the map closed and the roster derived, enumerated from both ends", () => {
    expect(ENV_EXAMPLE_SYNC_CODES).toEqual([
      "ENV_EXAMPLE_COMMIT_FAILED",
      "ENV_EXAMPLE_CONTRACT_UNAPPROVED",
      "ENV_EXAMPLE_REPOSITORY_UNBOUND",
      "ENV_EXAMPLE_REPOSITORY_UNREADABLE",
    ]);
    expect(new Set(Object.keys(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP))).toEqual(
      new Set(ENV_EXAMPLE_SYNC_CODES),
    );
    // FOUR, and no speculative fifth: an unthrown code is a claim that something can refuse
    // when nothing does, and it could never be drilled.
    expect(ENV_EXAMPLE_SYNC_CODES).toHaveLength(4);
  });

  /** Every code the roster names resolves to a layer the map authorizes — no undefined pair. */
  it("mints an authorized layer for every code in the roster", () => {
    let checked = 0;
    for (const code of ENV_EXAMPLE_SYNC_CODES) {
      const refusal = envExampleSyncRefusal(code);
      expect(refusal.layer).toBe(ENV_EXAMPLE_SYNC_CODE_LAYER_MAP[code]);
      expect(refusal.ok).toBe(false);
      checked += 1;
    }
    // A sweep that silently yields zero cases would otherwise pass vacuously.
    expect(checked).toBe(4);
  });

  /**
   * (C) The factory takes the CODE ONLY. A layer parameter would let a call site mint a
   * (code, layer) pair the map does not authorize — the disagreement must be inexpressible,
   * not merely discouraged. `detail` is defaulted, so it does not count toward `length`.
   */
  it("exposes no layer parameter on the refusal factory", () => {
    expect(envExampleSyncRefusal.length).toBe(1);
    expect(envExampleSyncRefusal("ENV_EXAMPLE_COMMIT_FAILED", "git exited 1").detail)
      .toBe("git exited 1");
    expect(envExampleSyncRefusal("ENV_EXAMPLE_COMMIT_FAILED").detail).toBeNull();
  });

  /** The refusal is frozen: a caller cannot rewrite the layer after the factory set it. */
  it("freezes the minted refusal", () => {
    const refusal = envExampleSyncRefusal("ENV_EXAMPLE_REPOSITORY_UNBOUND");
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  /**
   * (C, compile half) The (code, layer) correlation holds even for a call site that bypasses
   * the factory and hand-builds the object. `EnvExampleSyncRefusal` is a per-code mapped type,
   * not a loose pair of independent unions, so the wrong layer is a COMPILE error.
   *
   * These arms are graded by `pnpm typecheck`, not by vitest — vitest strips types. If the
   * correlation were ever weakened back to
   * `{code: EnvExampleSyncCode; layer: EnvExampleSyncLayer}`, the `@ts-expect-error` directive
   * would become unused and typecheck would red on it, which is exactly the alarm wanted.
   */
  it("makes a disagreeing (code, layer) pair inexpressible, even without the factory", () => {
    const honest: EnvExampleSyncRefusal = {
      code: "ENV_EXAMPLE_COMMIT_FAILED",
      detail: null,
      layer: "REPOSITORY_DELIVERY",
      ok: false,
    };
    expect(honest.layer).toBe("REPOSITORY_DELIVERY");

    // @ts-expect-error ENV_EXAMPLE_COMMIT_FAILED is mapped to REPOSITORY_DELIVERY, never
    // PROJECT_REDUCER. The directive sits on the DECLARATION, not on the `layer` line: the
    // assignability error is reported against the initialised binding, so a directive on the
    // property itself would be unused.
    const disagreeing: EnvExampleSyncRefusal = {
      code: "ENV_EXAMPLE_COMMIT_FAILED",
      detail: null,
      layer: "PROJECT_REDUCER",
      ok: false,
    };
    // The value still exists at runtime; the point is that it did not compile cleanly.
    expect(disagreeing.code).toBe("ENV_EXAMPLE_COMMIT_FAILED");
  });

  /**
   * (F) The one arm tying this module to the shared vocabulary edit. The kind is spelled here
   * and in `RUNTIME_COMMAND_KINDS`; this arm is what stops a rename half-landing.
   */
  it("names a kind that the runtime vocabulary actually carries", () => {
    expect(ENV_EXAMPLE_SYNC_COMMAND_KIND).toBe("product_contract.sync_env_example");
    expect(new Set<string>(RUNTIME_COMMAND_KINDS).has(ENV_EXAMPLE_SYNC_COMMAND_KIND)).toBe(true);
  });

  describe("isEnvExampleSyncRefusal", () => {
    it("admits a minted refusal", () => {
      for (const code of ENV_EXAMPLE_SYNC_CODES) {
        expect(isEnvExampleSyncRefusal(envExampleSyncRefusal(code))).toBe(true);
      }
    });

    it("rejects non-refusals", () => {
      expect(isEnvExampleSyncRefusal(null)).toBe(false);
      expect(isEnvExampleSyncRefusal(undefined)).toBe(false);
      expect(isEnvExampleSyncRefusal({})).toBe(false);
      expect(isEnvExampleSyncRefusal({ ok: true })).toBe(false);
      expect(isEnvExampleSyncRefusal("ENV_EXAMPLE_COMMIT_FAILED")).toBe(false);
    });

    /**
     * (E) A refusal from ANOTHER vocabulary is not one of ours. The guard checks the code
     * against the closed roster, so `ok === false` alone does not admit a foreign code.
     */
    it("rejects a foreign refusal that merely carries ok:false", () => {
      expect(isEnvExampleSyncRefusal({ code: "RELEASE_PR_FAILED", ok: false })).toBe(false);
      expect(isEnvExampleSyncRefusal({ ok: false })).toBe(false);
    });

    it("does not admit a code inherited from the prototype chain", () => {
      const inherited = Object.create({ code: "ENV_EXAMPLE_COMMIT_FAILED" }) as { ok?: unknown };
      inherited.ok = false;
      expect(isEnvExampleSyncRefusal(inherited)).toBe(false);
    });
  });

  /** The roster is the compile-time code set too, so a typo cannot reach the factory. */
  it("keeps the derived code type aligned with the map keys", () => {
    const codes: readonly EnvExampleSyncCode[] = ENV_EXAMPLE_SYNC_CODES;
    expect(codes.every((code) => code in ENV_EXAMPLE_SYNC_CODE_LAYER_MAP)).toBe(true);
  });
});
