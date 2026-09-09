/**
 * THE OFFER'S AUTHORITY, driven against a REAL store and the REAL ledger walk. Every arm that
 * asserts a version reads it back off the store INDEPENDENTLY rather than comparing the offer to
 * itself: a resolver that returned its own input would satisfy any self-referential assertion and
 * still refuse EXPECTED_VERSION_CONFLICT in front of an operator.
 */
import type { SqliteEventStore } from "@moe/store";
import { afterEach, expect, it } from "vitest";

import { recordDeployReceipt } from "../deployment/deploy-ledger.js";
import { DEPLOY_ENGINE_STAMP } from "../deployment/deploy-receipt-contracts.js";
import { PROJECT_ID, closeStores, openStore } from "../review/review-test-fixtures.js";
import {
  DEPLOY_ROLLBACK_LEDGER_UNREADABLE, DEPLOY_ROLLBACK_SCHEMA_VERSION, resolveRollbackOffers,
} from "./affordance-rollback-offers.js";

afterEach(closeStores);

const DIGEST = `sha256:${"b".repeat(64)}`;
const encoder = new TextEncoder();

/** A distinct 40-hex commit id per receipt: `DeployReceiptV1.sha` is admitted against a git
 *  object-id shape, so a readable label would be rejected on the WRITE. */
const shaOf = (seed: number): string => seed.toString(16).padStart(2, "0").repeat(20);

function deployed(store: SqliteEventStore, environment: string, decisionId: string, seed: number): void {
  const written = recordDeployReceipt(store, {
    decidedAt: "2026-09-08T01:00:00.000Z", decisionId, environment, imageDigest: DIGEST,
    projectId: PROJECT_ID, refusal: null, releaseDecision: null, sha: shaOf(seed), url: null,
  });
  if (!written.ok) throw new Error(written.code);
}

function refusedDeploy(store: SqliteEventStore, environment: string, decisionId: string, seed: number): void {
  const written = recordDeployReceipt(store, {
    decidedAt: "2026-09-08T02:00:00.000Z", decisionId, environment, imageDigest: null,
    projectId: PROJECT_ID,
    refusal: { code: "DEPLOY_BUILD_FAILED", detail: "exit code: 1", layer: DEPLOY_ENGINE_STAMP },
    releaseDecision: null, sha: shaOf(seed), url: null,
  });
  if (!written.ok) throw new Error(written.code);
}

/**
 * ADVANCE THE PROJECT AGGREGATE. Nothing this suite seeds writes to it - a deploy receipt lands
 * on `deploy:<project>:<environment>` and a target binding on its own aggregate - so without
 * this the project version is 0 and every assertion about the offered version passes against a
 * resolver that hard-codes zero. Measured: a `version = 0` mutant kept this file green until
 * this helper existed.
 */
function bumpProjectAggregate(store: SqliteEventStore, times: number): void {
  for (let index = 0; index < times; index += 1) {
    const marker = `project-bump-${index}`;
    store.commitExpectedVersionDecision({
      commandKind: "test.project_bump", committedResultBytes: encoder.encode("{}"),
      correlationId: marker, decidedAt: "2026-09-08T03:00:00.000Z",
      events: [{ eventId: marker, eventType: "TestProjectBumped", payload: encoder.encode("{}") }],
      expectedVersion: store.getAggregateVersion(PROJECT_ID),
      key: { commandId: marker, principalId: "test-bump", projectId: PROJECT_ID },
      requestBytes: encoder.encode(marker), targetAggregateId: PROJECT_ID,
    });
  }
}

const resolve = (store: SqliteEventStore) => resolveRollbackOffers({ projectId: PROJECT_ID, store });

it("offers nothing on a project that has never deployed", () => {
  expect(resolve(openStore())).toEqual({ offers: [], refused: null });
});

it("offers nothing when the only deploy that ran is the one running now", () => {
  const store = openStore();
  deployed(store, "production", "first", 1);
  expect(resolve(store).offers).toHaveLength(0);
});

/** DoD 1 at the offer seam, with every member traced to the handler rather than invented. */
it("offers exactly one project-scoped rollback once a second deploy has landed", () => {
  const store = openStore();
  deployed(store, "production", "first", 1);
  deployed(store, "production", "second", 2);
  // Read INDEPENDENTLY of the resolver: rollback-command.ts:160 commits its empty leg against
  // the PROJECT aggregate at exactly this version, so any other number refuses at dispatch.
  const projectVersion = store.getAggregateVersion(PROJECT_ID);
  expect(resolve(store)).toEqual({
    offers: [{
      aggregateId: PROJECT_ID,
      inputSchemaVersion: DEPLOY_ROLLBACK_SCHEMA_VERSION,
      kind: "deployment.rollback",
      version: projectVersion,
    }],
    refused: null,
  });
});

/**
 * THE VERSION IS READ, NOT ZERO, and this arm is the only thing that says so. Every other arm in
 * this file runs against a project aggregate still at 0, so a resolver hard-coding zero would
 * satisfy them all. Here the aggregate is advanced THREE times first, and the offer must carry 3.
 */
it("offers the project aggregate's CURRENT version, not the zero a fresh store would give", () => {
  const store = openStore();
  deployed(store, "production", "first", 1);
  deployed(store, "production", "second", 2);
  bumpProjectAggregate(store, 3);
  const projectVersion = store.getAggregateVersion(PROJECT_ID);
  expect(projectVersion).toBe(3);
  expect(resolve(store).offers[0]?.version).toBe(projectVersion);
  expect(resolve(store).offers[0]?.version).not.toBe(0);
});

/**
 * ONE OFFER, NOT ONE PER ENVIRONMENT. `preview` has a refused deploy on top of its only success,
 * so it holds no target at all; `production` holds one. The offer shape has no environment
 * member, so a second identical tuple would be indistinguishable from the first.
 */
it("mints a single offer no matter how many environments hold a target", () => {
  const store = openStore();
  deployed(store, "preview", "preview-first", 1);
  refusedDeploy(store, "preview", "preview-refused", 2);
  deployed(store, "production", "prod-first", 3);
  deployed(store, "production", "prod-second", 4);
  const result = resolve(store);
  expect(result.offers).toHaveLength(1);
  expect(result.offers[0]?.aggregateId).toBe(PROJECT_ID);
  expect(result.refused).toBeNull();
});

/** A REFUSED deploy on top does not create authority: production still has one deploy that ran. */
it("offers nothing when a refused deploy is all that sits on top of the running one", () => {
  const store = openStore();
  deployed(store, "production", "first", 1);
  refusedDeploy(store, "production", "refused", 2);
  expect(resolve(store).offers).toHaveLength(0);
});

/**
 * FAIL CLOSED, WITH ITS OWN CODE. "We could not read the ledger" and "there is nothing to roll
 * back to" must not look alike: the first is disclosed, the second is a plain empty offer set.
 */
it("withholds the offer with a specific code when the ledger cannot be read", () => {
  const unreadable = {
    getAggregateVersion: () => 7,
    readCommandDecisionsAfter: () => { throw new Error("database is locked"); },
  } as unknown as SqliteEventStore;
  expect(resolveRollbackOffers({ projectId: PROJECT_ID, store: unreadable })).toEqual({
    offers: [], refused: DEPLOY_ROLLBACK_LEDGER_UNREADABLE,
  });
});

/** A version that cannot be read is never guessed at either — same fail-closed answer. */
it("withholds the offer rather than fabricating a version the store cannot supply", () => {
  const store = openStore();
  deployed(store, "production", "first", 1);
  deployed(store, "production", "second", 2);
  const versionless = new Proxy(store, {
    get: (target, property, receiver) => property === "getAggregateVersion"
      ? () => { throw new Error("aggregate version unavailable"); }
      : Reflect.get(target, property, receiver) as unknown,
  });
  expect(resolveRollbackOffers({ projectId: PROJECT_ID, store: versionless })).toEqual({
    offers: [], refused: DEPLOY_ROLLBACK_LEDGER_UNREADABLE,
  });
});
