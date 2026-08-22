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

/** The one section this row makes optional. Every other advertised key stays mandatory. */
const TOLERATED = "budget";

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

describe("effect.activate payload fence — exactly two tolerated shapes", () => {
  it("accepts the full advertised section set", () => {
    // Also DoD 3's first direction: every key the vocabulary advertises is a key
    // the fence serves. If the roster ever advertised a section the fence does
    // not know, the membership check refuses here.
    expect(verdictFor(ADVERTISED).ok).toBe(true);
  });

  it("accepts the same payload minus the budget section", () => {
    // THE MIGRATION WINDOW. Red before task-8be27625's fence edit:
    // `keys.length === EFFECT_ACTIVATE_PAYLOAD_KEYS.length` refused this shape.
    expect(verdictFor(without(TOLERATED)).ok).toBe(true);
  });

  it("still passes the tolerated section through untouched when it is present", () => {
    // The tolerance is not a silent drop: a sender that has NOT migrated must
    // still see its bytes reach the domain stages, or link 2/3's incremental
    // migration would change behaviour for the senders that have not moved yet.
    const decoded = verdictFor(ADVERTISED);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const section = decoded.request.payload[TOLERATED];
    // STRUCTURAL, not `toStrictEqual`: the bounded JSON parser builds every
    // object with `Object.create(null)` (bounded-json-parser.ts:87) as a
    // prototype-pollution defence, so a strict comparison against a plain
    // literal fails on the prototype alone and reports "no visual difference".
    // The prototype is pinned on its own line rather than lost in that failure.
    expect(section).toEqual({ opaque: TOLERATED });
    expect(Object.getPrototypeOf(section)).toBeNull();
  });
});

describe("effect.activate payload fence — every other shape refuses, code unchanged", () => {
  /**
   * Derived from the ADVERTISED roster minus the one tolerated key, so a future
   * edit that drops `budget` from the roster (link 4's end state, arriving
   * early) changes this list's length and reddens the count assertion below
   * rather than silently shrinking the sweep.
   */
  const MANDATORY = without(TOLERATED);

  it("sweeps every mandatory section — a sweep that generated nothing would pass vacuously", () => {
    expect(MANDATORY.length).toBe(ADVERTISED.length - 1);
    expect(MANDATORY.length).toBeGreaterThan(0);
    expect(MANDATORY).not.toContain(TOLERATED);
  });

  for (const section of without(TOLERATED)) {
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
    // MEMBERSHIP STAYS EXACT WHILE THE COUNT RELAXES. This payload has the same
    // cardinality as the accepted full shape, so any implementation that widens
    // the fence by counting alone admits it.
    expect(verdictFor([...without(TOLERATED), "smuggled"])).toStrictEqual(MALFORMED);
  });

  it("refuses a budget-less-cardinality payload with one section swapped for an unknown key", () => {
    // The same trap one cardinality down: five keys, four of them advertised.
    // An implementation accepting "five or six keys, all known" would still
    // refuse this, but one accepting "five or six keys" would not.
    expect(verdictFor([...without(TOLERATED).slice(0, 4), "smuggled"])).toStrictEqual(MALFORMED);
  });
});
