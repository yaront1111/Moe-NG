import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DeploymentEnvironment, DeploymentsOutcome } from "../../live/live-deployments.js";
import { MIDDOT } from "../glyphs.js";

/**
 * DEPLOYING AS A QUEUE ITEM: the goal's work is published and the operator has somewhere to
 * put it. This module decides WHETHER that decision exists for a goal and what it is called;
 * `goal-deployments.tsx` renders the card and spends the offer. Nothing here fetches.
 *
 * IT READS `/deployments/read`, THE SAME AUTHORITY THE CARD READS, and that choice was
 * MEASURED rather than assumed. `/runs/read` looks like the cheaper source -- the queue
 * already polls it -- but it is wrong twice over. Its deployment rows are computed ONCE for
 * the whole project (`runs-read.ts` `deploymentsOf(store, projectId)`) and handed to every
 * goal view, so they can never say WHICH goal is ready; and its goal list is
 * `catalogBoundGoals`, which SKIPS every goal whose source-document binding is null. Measured
 * in the e2e lane at 11:41Z: `/runs/read` answered `goals: []` for a goal that had really
 * landed, really published and really carried a deploy offer, so a runs-derived item was
 * unreachable for it. `/deployments/read` is per goal and needs no binding.
 *
 * The goal axis is the daemon's own per-goal offer (`deployment.deploy` at `deploy:<goalId>`);
 * the deployment rows say only what happened to a sha.
 *
 * WHY THE RECEIPT IS WHAT CLEARS THE ITEM, and not the offer -- the same discipline
 * `needs-you-release.ts` records. The offer survives the deploy, because redeploying is a
 * normal thing to want, so an item derived from the offer alone would sit in the queue
 * forever. A DEPLOYED row AT THE GOAL'S PUBLISHED SHA is the daemon's own statement that this
 * work is out, and it is what makes the item go away.
 *
 * A REFUSED DEPLOY DOES NOT CLEAR IT, deliberately. A refused deploy is work the operator
 * still owes: the environment was left as it was and nothing reached users. Clearing on a
 * refusal would quietly retire the to-do at exactly the moment it became interesting.
 *
 * THE OFFER DECIDES WHETHER A DECISION EXISTS; THE READ ONLY DESCRIBES IT. The two daemon
 * surfaces genuinely disagree about when a goal is deployable, and this module follows the one
 * that grants the decision. `affordance-read.ts:411-417` offers `deployment.deploy` as soon as
 * the goal has a publish REQUEST, while `goal-deployment-read.ts:34` reports the deployable sha
 * only once the publish PUSHED (`publication?.outcome === "PUSHED" ? publication.sha : null`).
 * MEASURED in the e2e lane at 11:47Z: the offer was present at `deploy:goal-live-1` while
 * `/deployments/read` answered `sha: null`, because the lane's publish has no reachable remote.
 * Gating the item on the sha would hide a decision the daemon is actively offering, and the
 * operator would have no way to find out why. So a null sha still lists; it just cannot be
 * named. Whoever reconciles those two surfaces should revisit this, and the DISAGREEMENT is the
 * finding -- not this module's tolerance of it.
 */

export interface DeployFacts {
  /** The daemon's `deployment.deploy` offer, spent verbatim by deploy-port.ts. */
  readonly affordance: Readonly<Record<string, unknown>>;
  /** Environments carrying a bound target, in the daemon's order. */
  readonly environments: readonly string[];
  /** The refusal code of the last attempt at this sha, or null when none refused. */
  readonly refusalCode: string | null;
  /** The sha the daemon reports as deployable, or null while the publish has not pushed. */
  readonly sha: string | null;
}

/** The words and the facts for one DEPLOY item, or null when there is no decision to take. */
export interface DeployQueueOffer {
  readonly actionLabel: string;
  readonly detail: string;
  readonly facts: DeployFacts;
  readonly headline: string;
}

const DEPLOY_COMMAND_KIND = "deployment.deploy";

/** The aggregate the daemon names for a goal's deploy; mirrors `affordance-read.ts`. */
export function deployAggregateIdOf(goalId: string): string {
  return `deploy:${goalId}`;
}

function offerFor(
  surface: SurfaceFrame | null, goalId: string,
): Readonly<Record<string, unknown>> | null {
  if (surface === null || surface.outcome !== "SURFACE") return null;
  const target = deployAggregateIdOf(goalId);
  return surface.offers.find((offer) =>
    offer["commandKind"] === DEPLOY_COMMAND_KIND && offer["targetAggregateId"] === target) ?? null;
}

function detailFor(
  environments: readonly string[], refusalCode: string | null, sha: string | null,
): string {
  const where = environments.length === 0
    ? "No environment has a target bound yet"
    : `Bound: ${environments.join(", ")}`;
  // NAMED OR SAID TO BE UNKNOWN, never silently omitted: an operator who cannot see which
  // commit is going out should be told that, not shown a line with a hole in it.
  const what = sha === null ? "the commit is not published yet" : `commit ${sha.slice(0, 7)}`;
  return `${where} ${MIDDOT} ${what}`
    + (refusalCode === null ? "" : ` ${MIDDOT} last attempt refused ${refusalCode}`)
    + ". Open the goal to pick an environment and deploy.";
}

export function deployOfferFor(
  goalId: string,
  deployments: DeploymentsOutcome | undefined,
  surface: SurfaceFrame | null,
): DeployQueueOffer | null {
  if (deployments === undefined || deployments.status !== "DEPLOYMENTS") return null;
  const affordance = offerFor(surface, goalId);
  if (affordance === null) return null;
  const sha = deployments.sha;
  const rows: readonly DeploymentEnvironment[] = deployments.environments;
  // AT THIS SHA WHEN THERE IS ONE: a DEPLOYED row for an OLDER sha says the PREVIOUS work is
  // out, which is exactly the state this item exists to move the operator off. With no sha
  // there is no axis to compare, and each row already carries the environment's CURRENT
  // receipt, so a DEPLOYED one is the daemon's latest word and it clears.
  const current = sha === null ? rows : rows.filter((row) => row.sha === sha);
  if (current.some((row) => row.outcome === "DEPLOYED")) return null;
  const refusalCode = current.find((row) => row.outcome === "REFUSED")?.code ?? null;
  const environments = Object.freeze(rows.filter((row) => row.target !== null)
    .map((row) => row.environment));
  return Object.freeze({
    actionLabel: "Open the goal",
    detail: detailFor(environments, refusalCode, sha),
    facts: Object.freeze({ affordance, environments, refusalCode, sha }),
    headline: refusalCode === null
      ? "Your published work is ready to deploy"
      : "A deploy was refused and needs you again",
  });
}
