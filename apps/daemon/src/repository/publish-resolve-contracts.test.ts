import { RUNTIME_COMMAND_KINDS } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { GOAL_PREREQUISITE_LAYER } from "../goals/goal-close-prerequisite.js";

import {
  PUBLISH_RESOLVE_CODE_LAYER_MAP,
  PUBLISH_RESOLVE_CODES,
  PUBLISH_RESOLVE_COMMAND_KIND,
  publishResolveRefusal,
  type PublishResolveRefusal,
} from "./publish-resolve-contracts.js";

describe("repository.publish_resolve refusal vocabulary", () => {
  /**
   * Bidirectional, per project rail 9. Iterating `PUBLISH_RESOLVE_CODES` alone sees one
   * direction only: deleting a map entry shrinks that iteration and the arm stays green. So
   * enumerate from the MAP as well and assert set-equality; the sorted pin reds on any added
   * or dropped code.
   */
  it("keeps the map closed and the roster derived, enumerated from both ends", () => {
    expect(PUBLISH_RESOLVE_CODES).toEqual([
      "PUBLISH_RESOLVE_DECISION_NOT_FOUND",
      "PUBLISH_RESOLVE_NOT_UNKNOWN",
      "PUBLISH_RESOLVE_REMOTE_HOLDS_SHA",
    ]);
    expect(new Set(Object.keys(PUBLISH_RESOLVE_CODE_LAYER_MAP))).toEqual(new Set(PUBLISH_RESOLVE_CODES));
  });

  /**
   * The map's literal values are pinned BY IMPORT to the rostered constant they restate, so a
   * change to that constant's value reds here instead of drifting onto an unrostered string.
   */
  it("maps each code to its declared layer constant, by value", () => {
    expect(PUBLISH_RESOLVE_CODE_LAYER_MAP.PUBLISH_RESOLVE_DECISION_NOT_FOUND).toBe(GOAL_PREREQUISITE_LAYER);
    expect(PUBLISH_RESOLVE_CODE_LAYER_MAP.PUBLISH_RESOLVE_NOT_UNKNOWN).toBe(GOAL_PREREQUISITE_LAYER);
    expect(PUBLISH_RESOLVE_CODE_LAYER_MAP.PUBLISH_RESOLVE_REMOTE_HOLDS_SHA).toBe(GOAL_PREREQUISITE_LAYER);
  });

  it("mints exactly {code, detail, layer, ok}, frozen, for every code", () => {
    let checked = 0;
    for (const code of PUBLISH_RESOLVE_CODES) {
      const refusal = publishResolveRefusal(code, `why ${code}`);
      expect(refusal).toStrictEqual({ code, detail: `why ${code}`, layer: GOAL_PREREQUISITE_LAYER, ok: false });
      expect(Object.isFrozen(refusal)).toBe(true);
      checked += 1;
    }
    // A sweep that silently yields zero cases would otherwise pass vacuously.
    expect(checked).toBe(3);
  });

  /** No layer parameter: the map decides, so no call site can pair a code with another layer. */
  it("takes no layer argument and defaults the detail to null", () => {
    expect(publishResolveRefusal.length).toBe(1);
    expect(publishResolveRefusal("PUBLISH_RESOLVE_NOT_UNKNOWN").detail).toBeNull();
  });

  /**
   * Graded by `pnpm typecheck`, not vitest (vitest strips types). `honest` is the control: the
   * same literal with the right layer compiles, so the ONLY thing `disagreeing` gets wrong is
   * the layer. If the refusal type were weakened to independent code/layer unions, the
   * directive would go unused and typecheck would red on it.
   */
  it("makes a disagreeing (code, layer) pair a compile error, even without the factory", () => {
    const honest: PublishResolveRefusal = {
      code: "PUBLISH_RESOLVE_REMOTE_HOLDS_SHA",
      detail: null,
      layer: "DAEMON_PREREQUISITE",
      ok: false,
    };
    expect(honest.layer).toBe(GOAL_PREREQUISITE_LAYER);

    const disagreeing: PublishResolveRefusal = {
      code: "PUBLISH_RESOLVE_REMOTE_HOLDS_SHA",
      detail: null,
      // @ts-expect-error PUBLISH_RESOLVE_REMOTE_HOLDS_SHA maps to DAEMON_PREREQUISITE, never PROJECT_REDUCER.
      layer: "PROJECT_REDUCER",
      ok: false,
    };
    expect(disagreeing.code).toBe("PUBLISH_RESOLVE_REMOTE_HOLDS_SHA");
  });

  it("names a kind the runtime vocabulary actually carries", () => {
    expect(PUBLISH_RESOLVE_COMMAND_KIND).toBe("repository.publish_resolve");
    expect(new Set<string>(RUNTIME_COMMAND_KINDS).has(PUBLISH_RESOLVE_COMMAND_KIND)).toBe(true);
  });
});
