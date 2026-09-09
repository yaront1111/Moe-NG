import { describe, expect, it } from "vitest";

import type { DeploymentEnvironment, DeploymentsOutcome } from "../../live/live-deployments.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { deployAggregateIdOf, deployOfferFor } from "./needs-you-deploy.js";

const GOAL = "goal-1";
const SHA = "a".repeat(40);
const OLDER = "b".repeat(40);

const surfaceWith = (offers: readonly Readonly<Record<string, unknown>>[]): SurfaceFrame =>
  ({ connection: "LIVE", offers, outcome: "SURFACE" } as unknown as SurfaceFrame);

const OFFER = Object.freeze({
  commandKind: "deployment.deploy", expectedVersion: 2,
  targetAggregateId: deployAggregateIdOf(GOAL),
});
const SURFACE = surfaceWith([OFFER]);

const row = (over: Partial<DeploymentEnvironment> & { environment: string }): DeploymentEnvironment => ({
  code: null, detail: null, outcome: null, releaseDecision: null, sha: null, target: "local",
  time: null, url: null, ...over,
});

const readWith = (
  environments: readonly DeploymentEnvironment[], sha: string | null = SHA,
): DeploymentsOutcome => ({
  environments, goalRef: GOAL, releaseDecision: null, sha, status: "DEPLOYMENTS",
});

const bound = (environment: string): DeploymentEnvironment => row({ environment });

describe("deployOfferFor", () => {
  it("lists a goal whose published work has a deploy offer and no deploy at that sha", () => {
    const offer = deployOfferFor(GOAL, readWith([bound("preview"), bound("production")]), SURFACE);
    expect(offer?.headline).toBe("Your published work is ready to deploy");
    expect(offer?.facts.affordance).toBe(OFFER);
    expect(offer?.facts.sha).toBe(SHA);
    expect(offer?.facts.environments).toEqual(["preview", "production"]);
    expect(offer?.facts.refusalCode).toBeNull();
    expect(offer?.detail).toContain("Bound: preview, production");
    expect(offer?.detail).toContain(`commit ${SHA.slice(0, 7)}`);
  });

  it("STOPS listing the goal once a DEPLOYED row exists at the published sha", () => {
    // DoD 4's disappearance arm. An item that appears correctly but never clears leaves a
    // permanent false to-do, and the offer alone cannot clear it -- the daemon keeps offering
    // `deployment.deploy` after a deploy, because redeploying is a normal thing to want.
    const deployed = row({
      environment: "preview", outcome: "DEPLOYED", sha: SHA,
      time: "2026-09-07T09:05:00.000Z", url: "http://127.0.0.1:8080/",
    });
    expect(deployOfferFor(GOAL, readWith([deployed, bound("production")]), SURFACE)).toBeNull();
  });

  it("keeps listing the goal when the DEPLOYED row is for an OLDER sha", () => {
    // "Ever deployed" would clear the item the moment ANY previous work went out, which is
    // exactly the state this item exists to move the operator off.
    const stale = row({
      environment: "preview", outcome: "DEPLOYED", sha: OLDER, time: "2026-09-06T09:00:00.000Z",
    });
    expect(deployOfferFor(GOAL, readWith([stale]), SURFACE)?.headline)
      .toBe("Your published work is ready to deploy");
  });

  it("keeps listing the goal after a REFUSED deploy, and says which code refused", () => {
    // A refused deploy is work the operator still owes: nothing reached users. Clearing here
    // would retire the to-do at the moment it became interesting.
    const refused = row({
      code: "DEPLOY_BUILD_FAILED", environment: "preview", outcome: "REFUSED", sha: SHA,
      time: "2026-09-07T09:05:00.000Z",
    });
    const offer = deployOfferFor(GOAL, readWith([refused]), SURFACE);
    expect(offer?.headline).toBe("A deploy was refused and needs you again");
    expect(offer?.facts.refusalCode).toBe("DEPLOY_BUILD_FAILED");
    expect(offer?.detail).toContain("last attempt refused DEPLOY_BUILD_FAILED");
  });

  it("lists the goal with no bound environment in words, rather than an empty detail", () => {
    const offer = deployOfferFor(GOAL, readWith([]), SURFACE);
    expect(offer?.detail).toContain("No environment has a target bound yet");
  });

  it("counts only environments with a bound target as bound", () => {
    const offer = deployOfferFor(GOAL,
      readWith([bound("preview"), row({ environment: "production", target: null })]), SURFACE);
    expect(offer?.facts.environments).toEqual(["preview"]);
  });

  it("still lists the goal when the daemon offers a deploy but reports no deployable sha", () => {
    // The two daemon surfaces disagree: `affordance-read.ts` offers the deploy on the publish
    // REQUEST, `goal-deployment-read.ts:34` reports a sha only once the publish PUSHED.
    // MEASURED in the e2e lane: offer present, `sha: null`. Gating on the sha would hide a
    // decision the daemon is actively offering and tell the operator nothing about why.
    const offer = deployOfferFor(GOAL, readWith([bound("preview")], null), SURFACE);
    expect(offer?.facts.sha).toBeNull();
    expect(offer?.detail).toContain("the commit is not published yet");
    // With no sha to compare, the environment's CURRENT receipt is the daemon's latest word.
    expect(deployOfferFor(GOAL,
      readWith([row({ environment: "preview", outcome: "DEPLOYED", sha: OLDER,
        time: "2026-09-06T09:00:00.000Z" })], null), SURFACE)).toBeNull();
  });

  it("lists nothing without the offer or without an answered read", () => {
    // Each absence is its own arm: a wrong one of these collapsing to "listed" would put an
    // item in the queue the operator cannot act on.
    expect(deployOfferFor(GOAL, readWith([bound("preview")]), null)).toBeNull();
    expect(deployOfferFor(GOAL, readWith([bound("preview")]), surfaceWith([]))).toBeNull();
    expect(deployOfferFor(GOAL, readWith([bound("preview")]),
      surfaceWith([{ ...OFFER, commandKind: "deployment.set_target" }]))).toBeNull();
    expect(deployOfferFor(GOAL, readWith([bound("preview")]),
      surfaceWith([{ ...OFFER, targetAggregateId: "deploy:goal-2" }]))).toBeNull();
    expect(deployOfferFor(GOAL, undefined, SURFACE)).toBeNull();
    expect(deployOfferFor(GOAL, { code: "DEPLOYMENTS_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_DEPLOY", status: "ERROR" }, SURFACE)).toBeNull();
    expect(deployOfferFor("goal-2", readWith([bound("preview")]), SURFACE)).toBeNull();
  });

  it("names the deploy aggregate the way the daemon does", () => {
    expect(deployAggregateIdOf(GOAL)).toBe("deploy:goal-1");
  });
});
