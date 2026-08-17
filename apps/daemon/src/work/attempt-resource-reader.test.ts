import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
  DAEMON_ATTEMPT_RESOURCE,
} from "./attempt-resource-authority-contracts.js";
import type { AttemptResourceOutcome } from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-authority.js";
import {
  ACTIVATION_AGGREGATE, activatedWith, canonicalBytes, cleanRows, driftedBytes, duplicateRows,
  plantResourceEvent, resourceBody, resourceRow,
} from "./attempt-resource-test-harness.js";
import type { ResourceFixture } from "./attempt-resource-test-harness.js";

/**
 * The strict CURRENT reader.
 *
 * EVERY REPLAY GUARD IS REACHED BY PLANTING BYTES, not by asking the writer
 * nicely. The writer refuses a duplicate id, a drifted body and a second bind
 * before they can ever reach the store, so a guard against those is unguarded
 * unless a test plants them directly. `plantResourceEvent` is the only way in.
 *
 * Every refusal asserts the code, the LAYER, and that authority is "NONE" — a
 * refusal that granted authority would satisfy a code-only assertion.
 */

afterEach(cleanupRestoreHarnesses);

const hostFixture = (label: string): ResourceFixture => activatedWith(label, duplicateRows());

function refusalOf(outcome: AttemptResourceOutcome): {
  authority: string; code: string; refusedBy: string;
} {
  if (outcome.ok) throw new Error("expected a refusal, received a bound resource set");
  return { authority: outcome.authority, code: outcome.code, refusedBy: outcome.refusedBy };
}

const refused = (code: string) => ({
  authority: "NONE", code, refusedBy: DAEMON_ATTEMPT_RESOURCE,
});

const read = (fixture: ResourceFixture, projectId = PROJECT_ID): AttemptResourceOutcome =>
  readAttemptResources(fixture.store, ACTIVATION_AGGREGATE, projectId);

/** One valid bind, planted so the tail cases have a legitimate head to follow. */
function plantedBind(
  label: string, overrides: Readonly<Record<string, unknown>> = {},
): ResourceFixture {
  const fixture = hostFixture(label);
  plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
    canonicalBytes(resourceBody(overrides)), 0, `${label}-bind`);
  return fixture;
}

describe("attempt resource reader — the four distinct record faults", () => {
  it("answers ABSENT when nothing was ever bound", () => {
    expect(refusalOf(read(hostFixture("absent")))).toEqual(
      refused("ATTEMPT_RESOURCE_RECORD_ABSENT"));
  });

  it("answers UNREADABLE when the store itself refuses to read", () => {
    const fixture = plantedBind("unreadable");
    // A REAL store failure, not a mock: a closed handle throws STORE_CLOSED.
    fixture.store.close();
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_UNREADABLE"));
  });

  it("answers MALFORMED for bytes that decode but no longer canonicalise", () => {
    const fixture = hostFixture("drift");
    // Same JSON content, insertion order instead of sorted key order. A digest
    // check alone would pass this; only the re-encode comparison catches it.
    const drifted = driftedBytes({
      truthClass: "DAEMON_VERIFIED", ...resourceBody(),
    });
    // POSITIVE CONTROL, so this case cannot pass for some other reason. The
    // fixture's own insertion order is already alphabetical, so the SAME builder
    // serialised untouched produces byte-identical output — which means the only
    // difference in `drifted` is the one moved key, and the only guard that can
    // see it is the re-encode comparison.
    expect(driftedBytes(resourceBody())).toEqual(canonicalBytes(resourceBody()));
    expect(drifted).not.toEqual(canonicalBytes(resourceBody()));
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE, drifted, 0, "drift");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });

  it("answers AMBIGUOUS for two bind events and never picks one", () => {
    const fixture = plantedBind("ambiguous");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ members: [resourceRow("res-9")], memberCount: 1 })), 1,
      "ambiguous-second");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_AMBIGUOUS"));
  });
});

describe("attempt resource reader — the record must be about THIS attempt", () => {
  it("answers PROJECT_MISMATCH for a foreign expected project", () => {
    const fixture = plantedBind("foreign");
    expect(refusalOf(read(fixture, "project-foreign"))).toEqual(
      refused("ATTEMPT_RESOURCE_PROJECT_MISMATCH"));
    // The same bytes still answer for their OWN project, so the guard is the
    // comparison and not a record that was broken for everyone.
    expect(read(fixture).ok).toBe(true);
  });

  it("answers BINDING_MISMATCH for a transition naming another attempt", () => {
    const fixture = plantedBind("other-attempt");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      canonicalBytes(resourceBody({ attemptRef: "attempt-other" })), 1, "other-attempt-tail");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_BINDING_MISMATCH"));
  });

  it("answers BINDING_MISMATCH for a transition naming another effect intent", () => {
    const fixture = plantedBind("other-intent");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      canonicalBytes(resourceBody({ effectIntentRef: "intent-other" })), 1, "other-intent-tail");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_BINDING_MISMATCH"));
  });
});

describe("attempt resource reader — membership is complete or the record is UNKNOWN", () => {
  it("answers MEMBERSHIP_CHANGED for a transition that DROPS a member", () => {
    const fixture = plantedBind("dropped");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      canonicalBytes(resourceBody({
        memberCount: 2, members: [resourceRow("res-1"), resourceRow("res-2")],
      })), 1, "dropped-tail");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_MEMBERSHIP_CHANGED"));
  });

  it("answers MEMBERSHIP_CHANGED for a transition that ADDS a member", () => {
    const fixture = plantedBind("added");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      canonicalBytes(resourceBody({
        memberCount: 4, members: [...cleanRows(), resourceRow("res-4")],
      })), 1, "added-tail");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_MEMBERSHIP_CHANGED"));
  });

  it("answers MEMBER_DUPLICATE for a planted bind carrying the same id twice", () => {
    const fixture = hostFixture("planted-duplicate");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ members: duplicateRows() })), 0, "planted-duplicate");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_MEMBER_DUPLICATE"));
  });

  it("answers MALFORMED when memberCount disagrees with the member array", () => {
    const fixture = hostFixture("truncated");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ memberCount: 4 })), 0, "truncated");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });

  it("answers MALFORMED when one member carries an eighth field", () => {
    const fixture = hostFixture("eighth");
    const rows = cleanRows();
    rows[1] = resourceRow("res-2", { note: "extra" });
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ members: rows })), 0, "eighth");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });
});

describe("attempt resource reader — stream shape", () => {
  it("answers MALFORMED for an event type this module never writes", () => {
    const fixture = plantedBind("foreign-type");
    plantResourceEvent(fixture.store, "SomeForeignEvent",
      canonicalBytes(resourceBody()), 1, "foreign-type-tail");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });

  it("answers MALFORMED for a transition with no bind in front of it", () => {
    const fixture = hostFixture("headless");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_TRANSITION_EVENT_TYPE,
      canonicalBytes(resourceBody()), 0, "headless");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });

  it("answers MALFORMED for a record whose version is not this record version", () => {
    const fixture = hostFixture("version");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ recordVersion: "moe-attempt-resource-set/2" })), 0, "version");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });

  it("answers MALFORMED for a record whose truthClass was downgraded", () => {
    const fixture = hostFixture("truth");
    plantResourceEvent(fixture.store, ATTEMPT_RESOURCE_BOUND_EVENT_TYPE,
      canonicalBytes(resourceBody({ truthClass: "CALLER_CLAIMED" })), 0, "truth");
    expect(refusalOf(read(fixture))).toEqual(refused("ATTEMPT_RESOURCE_RECORD_MALFORMED"));
  });
});
