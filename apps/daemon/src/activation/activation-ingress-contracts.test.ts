import { describe, expect, it } from "vitest";

import { PAYLOAD_KEYS } from "../daemon-command-vocabulary.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
  decodeActivationRequestBytes,
} from "./activation-ingress-contracts.js";

/**
 * The `effect.activate` PAYLOAD FENCE, tested at its own layer.
 *
 * Until task-8be27625 this fence accepted exactly one payload shape — the full
 * six-section set — because its check was an exact count plus membership. This
 * row widens it to exactly TWO shapes so the 17 senders can drop their `budget`
 * section one at a time instead of in a flag day; link 4 (task-b8b69e74) removes
 * the tolerance again once every sender has migrated.
 *
 * WHY THIS FILE EXISTS AT ALL: before this row, NO test named
 * `decodeActivationRequestBytes`, `EFFECT_ACTIVATE_PAYLOAD_KEYS` or the fence
 * itself — measured with `grep -rln ... apps/daemon --include=*.test.ts`, zero
 * hits. The fence was exercised only transitively through
 * `runEffectActivateCommand`, which cannot distinguish "the shape was refused"
 * from "a domain stage refused" without reading the code off the outcome.
 *
 * ARRANGED-LAYER DISCIPLINE: every case here asserts the DECODER'S OWN verdict.
 * The end-to-end consequences — that the tolerated section is dead input, and
 * that the refusing LAYER is still `DAEMON_INGRESS` — are asserted through
 * production in `activation-ingress.test.ts`, where a seeded store exists.
 * Section VALUES are opaque here on purpose: the decoder is documented as
 * envelope-only, so a fixture carrying real domain sections would test the
 * domain stages' tolerance of this suite's literals rather than the fence.
 */

const encoder = new TextEncoder();

/**
 * The ADVERTISED roster, read from the dispatch surface the HTTP seam serves —
 * never from `EFFECT_ACTIVATE_PAYLOAD_KEYS` directly. DoD 3's set-equality is
 * between this list and what the fence DEMONSTRABLY accepts; reading the
 * fence's own constant on both sides would compare it to itself and pass no
 * matter what the fence does.
 */
const ADVERTISED: readonly string[] = PAYLOAD_KEYS[EFFECT_ACTIVATE_COMMAND_KIND];

/**
 * The section task-b8b69e74 RETIRED. It is no longer in the advertised roster, so it is not a
 * key the fence can serve — a payload carrying it is refused like any other unadvertised key.
 * Named here so the arms below can say what they are about; every advertised key is mandatory.
 */
const RETIRED = "budget";

const MALFORMED = Object.freeze({ code: "ACTIVATION_INGRESS_REQUEST_MALFORMED", ok: false });

function payloadOf(keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, { opaque: key }]));
}

function bytesOf(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-fence-1",
    correlationId: "corr-fence",
    decidedAt: "2026-08-15T00:00:00.000Z",
    expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload,
    principalId: "principal-1",
    projectId: "project-1",
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** The fence's verdict for a payload carrying exactly `keys`, nothing else. */
const verdictFor = (keys: readonly string[]): ReturnType<typeof decodeActivationRequestBytes> =>
  decodeActivationRequestBytes(bytesOf(payloadOf(keys)));

const without = (key: string): readonly string[] => ADVERTISED.filter((name) => name !== key);

/** The three ways a caller could still try to name the retired section. */
const RETIRED_SHAPES: readonly (readonly [string, unknown])[] = Object.freeze([
  Object.freeze(["a full section", { admission: { admissionRef: "adm-1" }, view: {} }] as const),
  Object.freeze(["an empty section", {}] as const),
  Object.freeze(["a null section", null] as const),
]);

/** The advertised shape plus a `budget` key carrying `section`, and nothing else. */
const withRetired = (section: unknown): ReturnType<typeof decodeActivationRequestBytes> =>
  decodeActivationRequestBytes(bytesOf({ ...payloadOf(ADVERTISED), [RETIRED]: section }));

describe("effect.activate payload fence — exactly ONE tolerated shape", () => {
  it("accepts the full advertised section set", () => {
    // Also DoD 3's first direction: every key the vocabulary advertises is a key
    // the fence serves. If the roster ever advertised a section the fence does
    // not know, the membership check refuses here.
    expect(verdictFor(ADVERTISED).ok).toBe(true);
  });

  it("advertises the retired section nowhere — it is not an accepted key at all", () => {
    // The window task-8be27625 opened for links 2 and 3 is CLOSED, and this is
    // the positive half of that claim: `budget` is absent from what the seam
    // advertises, so the arms below refuse an UNADVERTISED key rather than a key
    // the fence merely declines. The sweep's own case count is asserted here so
    // an empty RETIRED_SHAPES could not pass the refusal arm vacuously.
    expect(ADVERTISED).not.toContain(RETIRED);
    expect(RETIRED_SHAPES.length).toBeGreaterThan(0);
  });

  it.each(RETIRED_SHAPES)(
    "refuses a payload carrying %s of retired caller budget", (_label, section) => {
      // UNREPRESENTABLE, not ignored and not silently dropped. The VALUE cannot
      // make the difference — all three shapes answer identically, with the
      // fence's pre-existing code and no new vocabulary. The refusing LAYER is
      // asserted through production in activation-ingress-dead-input.test.ts,
      // where the seam that stamps it actually runs.
      expect(withRetired(section)).toStrictEqual(MALFORMED);
    });
});

describe("effect.activate payload fence — every other shape refuses, code unchanged", () => {
  /**
   * EVERY advertised key is mandatory now that the tolerated one is retired, so this list IS
   * the roster. The count assertion below reddens if the roster grows or shrinks under the
   * sweep rather than letting the sweep quietly narrow with it.
   */
  const MANDATORY = ADVERTISED;

  it("sweeps every mandatory section — a sweep that generated nothing would pass vacuously", () => {
    // PINNED TO LITERALS ON PURPOSE. The per-section arms below are GENERATED from
    // the roster, so they shrink with it: drop a section from
    // `EFFECT_ACTIVATE_PAYLOAD_KEYS` and its own refusal arm disappears rather than
    // failing. Measured — removing "lease" left this suite green except for an
    // unrelated cardinality arm. Comparing the roster to itself
    // (`MANDATORY.length === ADVERTISED.length`) is the same tautology one level up.
    // These two lines are the only place the contract is stated independently of the
    // code under test, which is what makes the generated sweep non-vacuous.
    expect(MANDATORY.length).toBe(5);
    expect([...MANDATORY].sort()).toStrictEqual(
      ["activation", "effect", "lease", "liveClaims", "slot"]);
    expect(MANDATORY).not.toContain(RETIRED);
  });

  for (const section of MANDATORY) {
    it(`refuses a payload missing the mandatory ${section} section`, () => {
      expect(verdictFor(without(section))).toStrictEqual(MALFORMED);
    });
  }

  it("refuses a payload carrying a smuggled key beyond the advertised roster", () => {
    // DoD 3's second direction: the fence serves NOTHING the roster does not
    // advertise, so the served set cannot be a strict superset.
    expect(verdictFor([...ADVERTISED, "smuggled"])).toStrictEqual(MALFORMED);
  });

  it("refuses a four-key payload", () => {
    expect(verdictFor(ADVERTISED.slice(0, 4))).toStrictEqual(MALFORMED);
  });

  it("refuses a full-cardinality payload with one section swapped for an unknown key", () => {
    // MEMBERSHIP IS EXACT, NOT ARITHMETIC. Same cardinality as the accepted
    // shape, one advertised section replaced, so a fence that counted alone
    // would admit it.
    expect(verdictFor([...ADVERTISED.slice(1), "smuggled"])).toStrictEqual(MALFORMED);
  });

  it("refuses a full-cardinality payload whose RETIRED budget key replaces a section", () => {
    // The trap this row's own edit creates, and the reason the arm above is not
    // enough: `budget` is a name the fence used to know. A fence that kept the
    // retired key in any tolerated shape, or that widened to "five keys, four of
    // them advertised", would accept this. Exact membership refuses it.
    expect(verdictFor([...ADVERTISED.slice(1), RETIRED])).toStrictEqual(MALFORMED);
  });
});
