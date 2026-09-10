/**
 * DoD 1'S LAST FOUR RECEIPTS on the fresh product: the environment fingerprints, the bound
 * target, a REAL docker deploy, and the health the daemon actually waited for.
 *
 * WHO DISPATCHES, AND WHY IT IS NOT THE BROWSER. `deployment.deploy` refuses any principal but
 * the CONFIGURED operator, and it says so in its own source rather than by omission --
 * `deploy-command.ts:195-197`, "Deploying a product is never an agent's decision" -- and it is
 * served ASYNCHRONOUSLY, so the registry's synchronous fence never even runs for that kind.
 * `deployment.set_target` and `environment.set_variable` sit in `OPERATOR_PRINCIPAL_KINDS` for
 * the same reason. The owner ruled on exactly this (comment-267eccae item 3): preview and deploy
 * MAY be driven over the configured-operator wire, with the actor named truthfully in the
 * record. So every dispatch here rides the lane's operator credential and the transcript says
 * so; nothing below implies a browser click, and NO FENCE IS TOUCHED.
 *
 * THE DEPLOY IS REAL DOCKER. No `fakeDocker`: the lane starts the daemon on the production
 * composition, `MOE_DEPLOY_BUILD_CONTEXT` names the product repository, and
 * `deploy-image-build.ts` streams `git archive <sha>` into `docker build --tag <tag> -`. Every
 * deploy spec in this repository before this one used the double (measured 2026-09-09), so this
 * is the first real-docker deploy the product has ever performed.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";

import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { deployTargetAggregateId }
  from "../../../apps/daemon/src/deployment/deploy-target-contracts.js";
import { candidateContainerName } from "../../../apps/daemon/src/deployment/deploy-service.js";
import type { DaemonLane } from "./daemon-ports.js";
import { lanePost } from "./lane-preview.js";
import { sleep } from "./live-proof-arms.js";

/** The environment this proof deploys. `preview` is the PRD's own first environment. */
export const LIVE_ENVIRONMENT = "preview";

/** Long: a real `docker build` on a cold node:24.16.0-alpine plus docker's own health retries. */
export const DEPLOY_WAIT_MS = 900_000;
const POLL_MS = 2_000;

/** Reads an aggregate's version from the lane's own store, as every operator dispatch must. */
function laneVersion(lane: DaemonLane, aggregateId: string): number {
  const store = SqliteEventStore.openForProject(
    join(lane.catalogPath, "..", "store.sqlite"), lane.projectId,
  );
  try { return store.getAggregateVersion(aggregateId); } finally { store.close(); }
}

function withStore<T>(lane: DaemonLane, read: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(
    join(lane.catalogPath, "..", "store.sqlite"), lane.projectId,
  );
  try { return read(store); } finally { store.close(); }
}

/** One operator dispatch. `credential` defaults to the lane's CONFIGURED operator credential. */
export async function operatorCommand(
  lane: DaemonLane, kind: string, aggregateId: string, payload: Record<string, unknown>,
  credential?: string,
): Promise<Record<string, unknown>> {
  const answer = await lanePost(lane, "/command", {
    commandId: `live-proof-${kind}-${String(Date.now())}`,
    commandKind: kind,
    correlationId: "live-proof-operator",
    expectedVersion: laneVersion(lane, aggregateId),
    payload,
    requestDigest: "d".repeat(64),
    schemaVersion: "moe-runtime-command/1",
    sessionCredential: credential ?? lane.credential,
    targetAggregateId: aggregateId,
  }, credential);
  return answer.body;
}

/** Binds where an environment deploys to. Written by the operator; only ever READ by the engine. */
export async function bindDeployTarget(
  lane: DaemonLane, environment: string, network: string, url: string,
): Promise<Record<string, unknown>> {
  return await operatorCommand(lane, "deployment.set_target",
    deployTargetAggregateId(lane.projectId, environment),
    { environment, network, sshTarget: null, url });
}

export interface EnvironmentFingerprint {
  readonly fingerprintSha256: string;
  readonly isSet: boolean;
  readonly name: string;
  readonly updatedAt: string;
}

/**
 * Sets one environment variable and answers the table the operator reads back.
 *
 * THE VALUE NEVER COMES BACK. `/environments/read` carries exactly four keys per row and the
 * value is not one of them; the operator's only confirmation that a write took is the
 * `fingerprintSha256` MOVING. That fingerprint is what DoD 1 calls the environment fingerprint,
 * and it is a sha256 of the value with its salt, never a prefix of the secret.
 */
export async function setEnvironmentVariable(
  lane: DaemonLane, environment: string, name: string, value: string,
): Promise<Record<string, unknown>> {
  return await operatorCommand(lane, "environment.set_variable",
    `environment/${environment}`, { environment, name, value });
}

/** The four-key rows `/environments/read` answers for one environment, in name order. */
export async function readEnvironmentFingerprints(
  lane: DaemonLane, environment: string,
): Promise<readonly EnvironmentFingerprint[]> {
  const read = await lanePost(lane, "/environments/read", { environment });
  const rows = read.body["rows"] ?? read.body["variables"] ?? [];
  const list = Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
  return list
    .map((row) => ({
      fingerprintSha256: String(row["fingerprintSha256"] ?? ""),
      isSet: row["isSet"] === true,
      name: String(row["name"] ?? ""),
      updatedAt: String(row["updatedAt"] ?? ""),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface LiveDeployReceipt {
  readonly containerName: string;
  readonly decisionId: string;
  readonly detail: string;
  readonly outcome: string;
  readonly sha: string;
  readonly url: string | null;
}

/**
 * Dispatches the deploy and waits for the DURABLE receipt.
 *
 * ACCEPTED IS NOT DEPLOYED, exactly as it is not for preview: `deployment.deploy` is an async
 * entry, so the command answer is about the dispatch and the durable fact is the receipt. A
 * REFUSED receipt is a decided fact and stops the wait immediately, carrying its own code --
 * this function never converts a refusal into a timeout, because a timeout reads as "slow" and
 * a refusal reads as "no", and the two must not be confusable in the transcript.
 */
export async function deployEnvironment(
  lane: DaemonLane, goalId: string, environment: string, sha: string,
): Promise<{ readonly accepted: Record<string, unknown>; readonly receipt: LiveDeployReceipt | null }> {
  const accepted = await operatorCommand(
    lane, "deployment.deploy", `deploy:${goalId}`, { environment, sha },
  );
  const deadline = Date.now() + DEPLOY_WAIT_MS;
  while (Date.now() < deadline) {
    const current = withStore(lane, (store) =>
      readCurrentDeployReceipt(store, lane.projectId, environment));
    if (current !== null && current.sha === sha) {
      const decisionId = String((current as { decisionId?: unknown }).decisionId ?? "");
      return {
        accepted,
        receipt: {
          containerName: decisionId === ""
            ? "" : candidateContainerName(environment, sha, decisionId),
          decisionId,
          detail: String((current as { detail?: unknown }).detail ?? ""),
          outcome: String((current as { outcome?: unknown }).outcome ?? ""),
          sha: current.sha,
          url: (current as { url?: unknown }).url === undefined
            ? null : String((current as { url?: unknown }).url),
        },
      };
    }
    await sleep(POLL_MS);
  }
  return { accepted, receipt: null };
}

function docker(argv: readonly string[]): { readonly out: string; readonly status: number } {
  try {
    return {
      out: execFileSync("docker", [...argv], {
        encoding: "utf8", shell: false, timeout: 120_000, windowsHide: true,
      }).trim(),
      status: 0,
    };
  } catch (error) {
    const shaped = error as { status?: number; stderr?: string; stdout?: string };
    return {
      out: `${String(shaped.stdout ?? "")}${String(shaped.stderr ?? "")}`.trim(),
      status: shaped.status ?? -1,
    };
  }
}

export interface LiveHealthProbe {
  /** `docker inspect`'s own health verdict for the deployed container. */
  readonly dockerHealth: string;
  /** The image tag docker reports the container is running. */
  readonly image: string;
  /** Exit status of the image's OWN healthcheck script, run inside the container. */
  readonly probeStatus: number;
  readonly probeOutput: string;
}

/**
 * Probes the DEPLOYED container two independent ways.
 *
 * WHY TWO. `docker inspect` reports the verdict docker reached from its own HEALTHCHECK, which
 * is the fact the daemon waited on -- but it is docker quoting itself. Running the image's
 * healthcheck script again, inside the running container, exercises the HTTP route the app
 * serves right now. A container that had become healthy and then died answers the first and
 * fails the second.
 */
export function probeDeployedContainer(containerName: string, healthPath: string): LiveHealthProbe {
  const health = docker(["inspect", "--format", "{{.State.Health.Status}}", containerName]);
  const image = docker(["inspect", "--format", "{{.Config.Image}}", containerName]);
  const probe = docker(["exec", containerName, "node", healthPath]);
  return {
    dockerHealth: health.status === 0 ? health.out : `INSPECT_FAILED ${health.out}`,
    image: image.status === 0 ? image.out : `INSPECT_FAILED ${image.out}`,
    probeOutput: probe.out,
    probeStatus: probe.status,
  };
}

/** Removes every container and image this proof created, by NAME and TAG, never by wildcard. */
export function cleanupDeployment(containerName: string, sha: string): void {
  if (containerName !== "") docker(["rm", "--force", containerName]);
  if (sha !== "") docker(["image", "rm", "--force", `moe-deploy-${LIVE_ENVIRONMENT}:${sha}`]);
}
