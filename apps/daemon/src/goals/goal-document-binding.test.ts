import { describe, expect, it } from "vitest";

import {
  admitDocumentSource,
  currentDocumentSourceRef,
  documentSourceLegOf,
  documentSourceRecordOf,
} from "../documents/document-source-leg.js";
import type { AdmittedDocumentSource } from "../documents/document-source-leg.js";
import { goalDocumentBindingLegs } from "./goal-document-binding.js";

const PROJECT_ID = "project-1";
const GOAL_ID = "goal-command-1";
const PRD = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";

function admitted(overrides: Partial<Record<string, unknown>> = {}): AdmittedDocumentSource {
  const outcome = admitDocumentSource({
    displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD, ...overrides,
  });
  if ("refusal" in outcome) throw new Error(`fixture refused: ${outcome.refusal.code}`);
  return outcome.value;
}

/** A store stub whose ONLY authority is the observed version of an aggregate. */
function versionPort(versions: Readonly<Record<string, number>>) {
  return { getAggregateVersion: (aggregateId: string): number => versions[aggregateId] ?? 0 };
}

/** The independently-derived source aggregate id for the fixture PRD. */
function fixtureSourceAggregateId(source: AdmittedDocumentSource): string {
  const record = documentSourceRecordOf(source);
  return documentSourceLegOf(PROJECT_ID, record, currentDocumentSourceRef(record)).aggregateId;
}

describe("task-fc42ae5e: goal document binding legs", () => {
  it("absent source: one APPEND leg carrying the source event at expectedVersion 0", () => {
    const source = admitted();
    const outcome = goalDocumentBindingLegs(
      versionPort({}), PROJECT_ID, GOAL_ID, source,
    );
    if ("refusal" in outcome) throw new Error(`refused: ${outcome.refusal.code}`);

    expect(outcome.legs).toHaveLength(1);
    const leg = outcome.legs[0];
    if (leg === undefined) throw new Error("no leg");
    expect(leg.aggregateId).toBe(fixtureSourceAggregateId(source));
    expect(leg.expectedVersion).toBe(0);
    // An APPEND leg, not a fence: exactly one source event travels with the goal decision.
    expect(leg.events).toHaveLength(1);
    const event = leg.events[0];
    if (event === undefined) throw new Error("no event");
    expect(event.eventType).toBe("DocumentSourceTextRecorded");
  });

  it("present source: a READ-ONLY FENCE leg, empty events, pinned at the observed version", () => {
    const source = admitted();
    const aggregateId = fixtureSourceAggregateId(source);
    const outcome = goalDocumentBindingLegs(
      versionPort({ [aggregateId]: 1 }), PROJECT_ID, GOAL_ID, source,
    );
    if ("refusal" in outcome) throw new Error(`refused: ${outcome.refusal.code}`);

    expect(outcome.legs).toHaveLength(1);
    const leg = outcome.legs[0];
    if (leg === undefined) throw new Error("no leg");
    expect(leg.aggregateId).toBe(aggregateId);
    // EXACTLY empty events is what the store reads as a fence granting no receipt authority.
    // A second goal carrying the same PRD must NOT append a second source event.
    expect(leg.events).toHaveLength(0);
    expect(leg.expectedVersion).toBe(1);
  });

  it("fence pins the OBSERVED version, not a constant", () => {
    const source = admitted();
    const aggregateId = fixtureSourceAggregateId(source);
    for (const observed of [1, 2, 7]) {
      const outcome = goalDocumentBindingLegs(
        versionPort({ [aggregateId]: observed }), PROJECT_ID, GOAL_ID, source,
      );
      if ("refusal" in outcome) throw new Error(`refused: ${outcome.refusal.code}`);
      const leg = outcome.legs[0];
      if (leg === undefined) throw new Error("no leg");
      expect(leg.expectedVersion).toBe(observed);
      expect(leg.events).toHaveLength(0);
    }
  });

  it("the binding is SERVER-DERIVED: the digest is of the admitted bytes, not any caller field", () => {
    const source = admitted();
    const outcome = goalDocumentBindingLegs(
      versionPort({}), PROJECT_ID, GOAL_ID, source,
    );
    if ("refusal" in outcome) throw new Error(`refused: ${outcome.refusal.code}`);

    const record = documentSourceRecordOf(source);
    expect(outcome.binding.contentSha256).toBe(record.contentSha256);
    expect(outcome.binding.byteLength).toBe(record.byteLength);
    expect(outcome.binding.sourceRef).toBe(currentDocumentSourceRef(record));
    expect(outcome.binding.sourceAggregateId).toBe(fixtureSourceAggregateId(source));
    // The binding names the DOCUMENT aggregate, never the goal's own.
    expect(outcome.binding.sourceAggregateId).not.toBe(GOAL_ID);
  });

  it("two goal-specific display paths for identical bytes bind to DISTINCT aggregates", () => {
    const a = admitted({ displayPath: "goals/one/prd.md" });
    const b = admitted({ displayPath: "goals/two/prd.md" });
    const legsA = goalDocumentBindingLegs(versionPort({}), PROJECT_ID, GOAL_ID, a);
    const legsB = goalDocumentBindingLegs(versionPort({}), PROJECT_ID, GOAL_ID, b);
    if ("refusal" in legsA || "refusal" in legsB) throw new Error("refused");

    expect(legsA.binding.contentSha256).toBe(legsB.binding.contentSha256);
    expect(legsA.binding.sourceAggregateId).not.toBe(legsB.binding.sourceAggregateId);
  });

  it("refuses when the source aggregate would collide with the goal's own aggregate", () => {
    const source = admitted();
    const outcome = goalDocumentBindingLegs(
      versionPort({}), PROJECT_ID, fixtureSourceAggregateId(source), source,
    );
    if (!("refusal" in outcome)) throw new Error("collision was accepted");
    // legs[0] is always the goal; a second leg naming the SAME aggregate is refused by the
    // store as a duplicate, so this refuses here with its own code and layer instead.
    expect(outcome.refusal.code).toBe("GOAL_CREATE_SOURCE_AGGREGATE_COLLISION");
    expect(outcome.refusal.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(outcome.refusal.ok).toBe(false);
  });
});
