/**
 * DoD 1'S LAST FOUR RECEIPTS, IN ONE ORDERED PASS: Gate 2's preview and its decision, the
 * environment fingerprints, a real docker deploy with its health, and the migration receipt.
 *
 * THE ORDER IS THE PRODUCT'S, NOT THIS FILE'S. A preview serves a landed sha, so it follows the
 * landings. Environment variables are bound before the deploy that consumes them. The migration
 * is keyed by the DEPLOY DECISION -- `readMigrationObservation` resolves a receipt by the deploy
 * receipt's `decisionId` -- so it can only be recorded once a deploy has decided, and this pass
 * therefore takes the decision id from the durable receipt rather than constructing one.
 *
 * EVERY DISPATCH IS THE CONFIGURED OPERATOR'S, AND THE RECORD SAYS SO. The owner ruled at
 * comment-267eccae item 3 that preview and deploy may ride the operator wire with the actor
 * named truthfully. No fence is edited, no principal is widened, and nothing here implies the
 * browser clicked anything: `actor` is carried in the returned record for every leg.
 *
 * A REFUSAL IS AN OUTCOME, NEVER A THROW. Each leg records what the daemon actually answered and
 * the pass continues to the next independent leg, so one wall does not hide the three legs
 * behind it. The caller asserts; this file measures.
 */
import type { DaemonLane } from "./daemon-ports.js";
import { decideLanePreview, readLanePreview, startLanePreview } from "./lane-preview.js";
import {
  LIVE_ENVIRONMENT, bindDeployTarget, deployEnvironment, probeDeployedContainer,
  readEnvironmentFingerprints, setEnvironmentVariable,
} from "./live-proof-deploy.js";
import type { EnvironmentFingerprint, LiveDeployReceipt, LiveHealthProbe } from "./live-proof-deploy.js";
import { IMAGE_HEALTHCHECK_PATH } from "./live-proof-image.js";
import { readProductMigration } from "./live-proof-migration.js";
import type { LiveMigrationOutcome } from "./live-proof-migration.js";

/**
 * The variables the PRD's app needs. Values are inert: the daemon never returns them.
 *
 * DATABASE_URL IS LOAD-BEARING, not decoration. `resolveDeployMigrationContext` reads it out of
 * the environment slice and hands it to the product's own migration, so a value nothing listens
 * on refuses the DEPLOY. It is supplied by the caller because only the caller knows which
 * database it started.
 */
const variables = (databaseUrl: string): readonly { readonly name: string; readonly value: string }[] =>
  Object.freeze([
    { name: "DATABASE_URL", value: databaseUrl },
    { name: "SESSION_SECRET", value: "live-proof-session-secret-not-in-any-record" },
  ]);

export interface LivePreviewLeg {
  readonly actor: "CONFIGURED_OPERATOR";
  readonly decision: Record<string, unknown> | null;
  /** The preview record as `/preview/read` answers it AFTER the decision is committed. */
  readonly readBack: Record<string, unknown>;
  readonly receiptId: string | null;
  readonly refusal: string | null;
  readonly url: string | null;
}

export interface LiveOperateOutcome {
  readonly deploy: {
    readonly accepted: Record<string, unknown>;
    readonly actor: "CONFIGURED_OPERATOR";
    readonly health: LiveHealthProbe | null;
    readonly receipt: LiveDeployReceipt | null;
    readonly target: Record<string, unknown>;
  };
  readonly environment: {
    readonly actor: "CONFIGURED_OPERATOR";
    readonly fingerprints: readonly EnvironmentFingerprint[];
    readonly written: readonly Record<string, unknown>[];
  };
  readonly migration: LiveMigrationOutcome | null;
}

/**
 * Gate 2: ask for a preview of the landed sha, then commit the operator's verdict on it.
 *
 * SEPARATE FROM THE DEPLOY LEGS ON PURPOSE, and the product forces it: `deployment.deploy`'s
 * prerequisite table (`bootstrap-sequence.ts:55`) reads a COMMITTED `repository.publish`
 * DECISION, so a deploy can only follow Gate 3. Gate 2 precedes Gate 3. Running them as one
 * call would have put the preview after the release, which is neither the product's order nor
 * the DoD's.
 */
export async function previewLiveProof(
  lane: DaemonLane, goalId: string, sha: string,
): Promise<LivePreviewLeg> {
  const started = await startLanePreview(lane, goalId, sha);
  if (!started.ok) {
    return {
      actor: "CONFIGURED_OPERATOR", decision: null,
      readBack: (await readLanePreview(lane, goalId)).body,
      receiptId: null, refusal: started.detail.slice(0, 1500), url: null,
    };
  }
  // APPROVE's payload is EXACTLY {decision, previewRef} -- a `findings` key here is an unknown
  // key, not an empty roster, so the approving call must not pass one.
  const decision = await decideLanePreview(lane, started.receiptId, "APPROVE", undefined, goalId);
  return {
    actor: "CONFIGURED_OPERATOR", decision: decision.body,
    readBack: (await readLanePreview(lane, goalId)).body,
    receiptId: started.receiptId, refusal: null, url: started.url,
  };
}

/**
 * Runs the post-Gate-3 DoD 1 legs against the released sha and answers what each one produced.
 *
 * `database` names the postgres container the caller's environment brought up; this pass starts
 * nothing of its own and therefore removes nothing.
 */
export async function deployLiveProof(options: {
  /** The postgres container the environment brought up, asked directly for what the DDL did. */
  readonly database: string;
  readonly databaseUrl: string;
  readonly goalId: string;
  readonly lane: DaemonLane;
  /** The docker network the running environment is on; the candidate joins THAT one. */
  readonly network: string;
  readonly sha: string;
  readonly storePath: string;
  /** Where the environment's proxy answers from the host. It reaches the deploy receipt. */
  readonly url: string;
}): Promise<LiveOperateOutcome> {
  const { goalId, lane, sha } = options;
  const written: Record<string, unknown>[] = [];
  for (const variable of variables(options.databaseUrl)) {
    written.push(await setEnvironmentVariable(lane, LIVE_ENVIRONMENT, variable.name, variable.value));
  }
  const fingerprints = await readEnvironmentFingerprints(lane, LIVE_ENVIRONMENT);

  // THE NETWORK IS THE RUNNING ENVIRONMENT'S, MEASURED FROM DOCKER, not a name this file
  // invents: `createProxyPort` discovers the proxy with `--filter network=<target.network>`, so a
  // target bound to a network nothing runs on refuses DEPLOY_PROXY_MISSING_OR_AMBIGUOUS.
  const target = await bindDeployTarget(lane, LIVE_ENVIRONMENT, options.network, options.url);
  const deployed = await deployEnvironment(lane, goalId, LIVE_ENVIRONMENT, sha);
  const health = deployed.receipt === null || deployed.receipt.containerName === ""
    ? null
    : probeDeployedContainer(deployed.receipt.containerName, IMAGE_HEALTHCHECK_PATH);

  // KEYED BY THE DEPLOY DECISION, read from the durable receipt. A migration receipt keyed by an
  // id this file invented would decode, persist and resolve to nothing.
  const migration = deployed.receipt === null || deployed.receipt.decisionId === ""
    ? null
    : readProductMigration({
      database: options.database,
      projectId: lane.projectId,
      requestId: deployed.receipt.decisionId,
      storePath: options.storePath,
    });

  return {
    deploy: { accepted: deployed.accepted, actor: "CONFIGURED_OPERATOR", health,
      receipt: deployed.receipt, target },
    environment: { actor: "CONFIGURED_OPERATOR", fingerprints, written },
    migration,
  };
}
