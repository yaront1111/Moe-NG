import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import {
  RELEASE_DOSSIER_COMMAND_KIND, RELEASE_DOSSIER_PRINCIPAL_ID, decodeReleaseDossierBytes,
  releaseDossierAggregateId, releaseDossierId,
} from "./release-dossier-contracts.js";
import { GOAL_ID, HEAD_SHA, OTHER_SHA, ancestryOf, dossierInput } from "./release-dossier-fixtures.js";
import { readReleaseDossier, recordReleaseDossier } from "./release-dossier-ledger.js";
import { renderReleaseDossier } from "./release-dossier.js";

afterEach(closeStores);

const DECIDED_AT = "2026-09-05T12:00:00.000Z";

/**
 * `openStore()` binds the store to review-test-fixtures' PROJECT_ID, and the ledger
 * reads are project-scoped, so the record and the rendered bytes must agree on it.
 */
const render = (sha: string): string =>
  renderReleaseDossier(dossierInput({ projectId: PROJECT_ID }), sha, ancestryOf().predicate);

const recordAt = (
  store: ReturnType<typeof openStore>, sha: string,
): ReturnType<typeof recordReleaseDossier> => recordReleaseDossier(
  store,
  { decidedAt: DECIDED_AT, goalId: GOAL_ID, markdown: render(sha), projectId: PROJECT_ID, sha },
);

describe("release dossier durable bytes", () => {
  it("stores the bytes and reads back a dossier that re-derives identically", () => {
    const store = openStore();
    const markdown = render(HEAD_SHA);
    const recorded = recordReleaseDossier(
      store, { decidedAt: DECIDED_AT, goalId: GOAL_ID, markdown, projectId: PROJECT_ID, sha: HEAD_SHA },
    );
    if (!recorded.ok) throw new Error(recorded.code);
    expect(recorded.replayed).toBe(false);

    const read = readReleaseDossier(store, PROJECT_ID, recorded.dossier.dossierId);
    if (!read.ok) throw new Error(read.code);
    // The READ-BACK bytes must re-derive the identical dossier: this is why the PR body
    // is the stored record and not a second rendering, which is how a PR and the durable
    // record come to disagree.
    expect(Buffer.from(read.dossier.markdown, "utf8").equals(Buffer.from(markdown, "utf8")))
      .toBe(true);
    expect(read.dossier.markdown).toBe(render(HEAD_SHA));
    expect(read.dossier.sha).toBe(HEAD_SHA);
    expect(read.dossier.version).toBe("moe-release-dossier/1");
    expect(read.decision.commandKind).toBe(RELEASE_DOSSIER_COMMAND_KIND);
    expect(read.decision.key.principalId).toBe(RELEASE_DOSSIER_PRINCIPAL_ID);
    // Beside the goal, never on it: recording evidence must not move the goal's version.
    expect(read.decision.targetAggregateId).toBe(releaseDossierAggregateId(GOAL_ID));
    expect(store.getAggregateVersion(GOAL_ID)).toBe(0);
    expect(store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID))).toBe(1);
  });

  it("replays the same record for a repeated release rather than accumulating duplicates", () => {
    const store = openStore();
    const input = {
      decidedAt: DECIDED_AT, goalId: GOAL_ID, markdown: render(HEAD_SHA),
      projectId: PROJECT_ID, sha: HEAD_SHA,
    };
    const first = recordReleaseDossier(store, input);
    const second = recordReleaseDossier(store, input);
    if (!first.ok || !second.ok) throw new Error("record refused");
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.dossier.dossierId).toBe(first.dossier.dossierId);
    // One release, one durable record: the aggregate advanced exactly once.
    expect(store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID))).toBe(1);
  });

  it("keys the id on (projectId, goalId, sha), so two shas are two records", () => {
    expect(releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA))
      .toBe(releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA));
    expect(releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA))
      .not.toBe(releaseDossierId(PROJECT_ID, GOAL_ID, OTHER_SHA));
    expect(releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA))
      .not.toBe(releaseDossierId("proj-other", GOAL_ID, HEAD_SHA));
    expect(releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA))
      .not.toBe(releaseDossierId(PROJECT_ID, "goal-other", HEAD_SHA));
    const store = openStore();
    const atHead = recordAt(store, HEAD_SHA);
    const atOther = recordAt(store, OTHER_SHA);
    if (!atHead.ok || !atOther.ok) throw new Error("record refused");
    // Two shas, two records on the goal's release aggregate — not one overwritten.
    expect(store.getAggregateVersion(releaseDossierAggregateId(GOAL_ID))).toBe(2);
    expect(atHead.dossier.dossierId).not.toBe(atOther.dossier.dossierId);
    expect(atHead.dossier.markdown).not.toBe(atOther.dossier.markdown);
  });

  it("answers RELEASE_DOSSIER_NOT_FOUND for an id that was never recorded", () => {
    const read = readReleaseDossier(
      openStore(), PROJECT_ID, releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA),
    );
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected a refusal");
    expect(read.code).toBe("RELEASE_DOSSIER_NOT_FOUND");
  });
});

describe("release dossier byte decoding", () => {
  const bytesOf = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));

  const valid = (): Record<string, unknown> => ({
    dossierId: releaseDossierId(PROJECT_ID, GOAL_ID, HEAD_SHA),
    goalId: GOAL_ID,
    markdown: render(HEAD_SHA),
    projectId: PROJECT_ID,
    sha: HEAD_SHA,
    version: "moe-release-dossier/1",
  });

  it("accepts bytes it wrote", () => {
    expect(decodeReleaseDossierBytes(bytesOf(valid())).ok).toBe(true);
  });

  it("refuses bytes whose id does not re-derive from (projectId, goalId, sha)", () => {
    // A forged or drifted id must not pass: the id IS the claim that these bytes are
    // the record for that release.
    const forged = { ...valid(), sha: OTHER_SHA };
    const decoded = decodeReleaseDossierBytes(bytesOf(forged));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.code).toBe("RELEASE_DOSSIER_INVALID");
  });

  it("refuses bytes carrying an unexpected key, a wrong version, or a missing field", () => {
    for (const mutate of [
      (value: Record<string, unknown>) => ({ ...value, extra: 1 }),
      (value: Record<string, unknown>) => ({ ...value, version: "moe-release-dossier/2" }),
      (value: Record<string, unknown>) => {
        const { markdown: _dropped, ...rest } = value;
        return rest;
      },
    ]) {
      const decoded = decodeReleaseDossierBytes(bytesOf(mutate(valid())));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("expected a refusal");
      expect(decoded.code).toBe("RELEASE_DOSSIER_INVALID");
    }
  });
});
