import { describe, expect, it } from "vitest";

import { ACTIVATION_WITNESS, activatePayload } from "./bootstrap-test-fixtures.js";

/**
 * `activatePayload` is the single seam every in-repo `project.activate` sender goes through, so
 * task-4b9c394debe94b41a80e2b46c6d55ab8 can make the daemon mint the witness by changing one
 * body. These arms pin the two shapes the twelve migrated call sites relied on before the
 * refactor — a bare base witness, and an override MERGED over it — because a helper that
 * replaced instead of merging would silently send a one-key witness and turn a CORE_REDUCER
 * weak-truth refusal into an ingress shape refusal while both arms stayed "red for a refusal".
 */
describe("activatePayload", () => {
  it("builds the bare payload every sender used to inline", () => {
    expect(activatePayload()).toEqual({ witness: ACTIVATION_WITNESS });
  });

  it("treats an explicitly-undefined override as the bare base, like the `??` it replaced", () => {
    // `provider-profile-resolver.test.ts` forwards an OPTIONAL field, so the helper receives an
    // explicit `undefined` on the default branch — a defaulted parameter and a `=== undefined`
    // test agree here, but only one of them is written down.
    expect(activatePayload(undefined)).toEqual({ witness: ACTIVATION_WITNESS });
  });

  it("merges an override over the base instead of replacing it", () => {
    const witness = activatePayload({ truthClass: "OBSERVED" }).witness as Record<string, unknown>;

    // Set-equality on the KEYS is the discriminator: a replacing helper yields exactly one key
    // here and would still satisfy `witness.truthClass === "OBSERVED"`.
    expect(Object.keys(witness).sort()).toEqual(Object.keys(ACTIVATION_WITNESS).sort());
    expect(witness.truthClass).toBe("OBSERVED");
    expect(witness.signingKeyRef).toBe(ACTIVATION_WITNESS.signingKeyRef);
    expect(witness.providerMinimumProfileRef).toBe(ACTIVATION_WITNESS.providerMinimumProfileRef);
    expect(witness).toEqual({ ...ACTIVATION_WITNESS, truthClass: "OBSERVED" });
  });

  it("reproduces both branches of the whole-witness substitution byte for byte", () => {
    // The `options.witness ?? ACTIVATION_WITNESS` site substituted a COMPLETE witness. Merging a
    // complete witness over the base is the same object, so the migrated call site sends exactly
    // what it sent before on both the supplied and the absent branch.
    const supplied = { ...ACTIVATION_WITNESS, providerMinimumProfileRef: "provider-profile-2" };

    expect(activatePayload(supplied)).toEqual({ witness: supplied });
    expect(activatePayload(undefined)).toEqual({ witness: ACTIVATION_WITNESS });
  });

  it("does not mutate the frozen base witness", () => {
    activatePayload({ truthClass: "OBSERVED" });

    expect(ACTIVATION_WITNESS.truthClass).toBe("DAEMON_VERIFIED");
    expect(Object.isFrozen(ACTIVATION_WITNESS)).toBe(true);
  });
});
