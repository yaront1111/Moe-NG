import { describe, expect, it } from "vitest";

import { SIGNING_UNSIGNED_REF, activationWitnessOf } from "./activation-receipts.js";
import {
  ACTIVATION_WITNESS,
  FIXTURE_ACTIVATION_RECEIPTS,
  activatePayload,
  receiptsWithProviderRef,
} from "./bootstrap-test-fixtures.js";

/**
 * `activatePayload` is the single seam every in-repo `project.activate` sender goes through.
 * task-960254c5 built it; task-4b9c394d then FLIPPED its body, which is exactly what the seam
 * existed for — one function changed instead of sixteen call sites, and no window in which those
 * files sat red on a shared branch owned by neither row.
 *
 * THE ARMS BELOW ARE INVERTED FROM WHAT THEY PINNED BEFORE, because the helper's contract is
 * inverted. It used to answer "the witness every sender inlines"; it now answers "the payload a
 * well-behaved sender carries", which is NOTHING. The override branch survives only to build
 * HOSTILE payloads for the refusal arms.
 */
describe("activatePayload", () => {
  it("builds an EMPTY payload: the daemon mints the witness, so a sender carries none", () => {
    expect(activatePayload()).toEqual({});
    expect(Object.keys(activatePayload())).toHaveLength(0);
  });

  it("treats an explicitly-undefined override as the bare branch, like the `??` it replaced", () => {
    // `provider-profile-resolver.test.ts` forwards an OPTIONAL field, so the helper receives an
    // explicit `undefined` on the default branch — a defaulted parameter and a `=== undefined`
    // test agree here, but only one of them is written down.
    expect(activatePayload(undefined)).toEqual({});
  });

  it("still builds a HOSTILE witness when given overrides, for the refusal arms", () => {
    const witness = activatePayload({ truthClass: "OBSERVED" }).witness as Record<string, unknown>;

    // Set-equality on the KEYS is the discriminator: a replacing helper yields exactly one key
    // here and would still satisfy `witness.truthClass === "OBSERVED"` — and a one-key payload
    // would be refused for its SHAPE, not for being caller-supplied, which is a different test.
    expect(Object.keys(witness).sort()).toEqual(Object.keys(ACTIVATION_WITNESS).sort());
    expect(witness.truthClass).toBe("OBSERVED");
    expect(witness.providerMinimumProfileRef).toBe(ACTIVATION_WITNESS.providerMinimumProfileRef);
    expect(witness).toEqual({ ...ACTIVATION_WITNESS, truthClass: "OBSERVED" });
  });

  it("keeps the two branches distinguishable: bare is empty, overridden carries a witness", () => {
    const supplied = { ...ACTIVATION_WITNESS, providerMinimumProfileRef: "provider-profile-2" };

    expect(activatePayload(supplied)).toEqual({ witness: supplied });
    expect(activatePayload()).not.toHaveProperty("witness");
  });

  it("does not mutate the frozen base witness", () => {
    activatePayload({ truthClass: "OBSERVED" });

    expect(ACTIVATION_WITNESS.truthClass).toBe("DAEMON_VERIFIED");
    expect(Object.isFrozen(ACTIVATION_WITNESS)).toBe(true);
  });
});

/**
 * THE FIXTURE RECEIPTS MINT THE FIXTURE WITNESS, BYTE FOR BYTE.
 *
 * That identity is load-bearing: it is what lets ~60 downstream suites keep asserting the same
 * durable activation payload they asserted before the daemon started minting it, without a
 * single one of them being edited. If the two ever drift, those suites fail far from here with
 * no explanation, so the equality is pinned at its source.
 */
describe("FIXTURE_ACTIVATION_RECEIPTS", () => {
  it("assembles exactly ACTIVATION_WITNESS through the PRODUCTION minter", () => {
    const assembly = activationWitnessOf(FIXTURE_ACTIVATION_RECEIPTS);

    // Driven through `activationWitnessOf` itself, never through a re-implementation of it:
    // a helper that rebuilt the mapping here could agree with a broken minter.
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) throw new Error(assembly.refusals.map((r) => r.code).join(", "));
    expect(assembly.witness).toEqual({ ...ACTIVATION_WITNESS });
  });

  it("states the MINTED signing ref, which is why the two can be equal at all", () => {
    // `activationWitnessOf` hard-codes `signingKeyRef: SIGNING_UNSIGNED_REF`. While the fixture
    // said "signing-1" no measured receipt set could ever assemble this constant, and every
    // downstream suite would have needed an edit.
    expect(ACTIVATION_WITNESS.signingKeyRef).toBe(SIGNING_UNSIGNED_REF);
  });

  it("varies only the provider ref when asked, leaving the other eight keys alone", () => {
    const assembly = activationWitnessOf(receiptsWithProviderRef("provider-profile-2"));

    expect(assembly.ok).toBe(true);
    if (!assembly.ok) throw new Error(assembly.refusals.map((r) => r.code).join(", "));
    expect(assembly.witness).toEqual({
      ...ACTIVATION_WITNESS, providerMinimumProfileRef: "provider-profile-2",
    });
  });
});
