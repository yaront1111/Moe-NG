/**
 * THE PIECES A DEPLOY-ROLLBACK JOURNEY NEEDS THAT NO EXISTING LANE HELPER OWNS.
 *
 * THE ONE IDEA WORTH READING BEFORE THE CODE: the environment this lane probes is a REAL HTTP
 * SERVER whose verdict is a function of the deploy ledger the daemon itself writes. It answers
 * 200 only while the environment's CURRENT deploy receipt names the sha it was told is good, and
 * 503 otherwise. Nothing flips it by hand, so "the release broke it" and "the rollback fixed it"
 * are both consequences of receipts the production command edge committed - not of a test
 * reaching over and toggling a boolean at the moment it needs one.
 *
 * WHAT IS THEREFORE STILL A DOUBLE, stated plainly because the distinction is the whole value of
 * the lane: no container ever runs. `fake-docker-dependencies.ts` doubles the deploy's SPAWNS at
 * the production composition seam, so the image that would serve this URL does not exist. This
 * server stands in for the container's answer, and it is honest about the one thing the double
 * cannot prove - that an image built from sha A serves differently from one built from sha B.
 * What it does prove is that the daemon's probe loop, its incident lifecycle, its rollback
 * command and the browser's three surfaces are wired to each other and to the receipt ledger.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

import { expect } from "@playwright/test";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";

import { readCurrentDeployReceipt } from "../../../apps/daemon/src/deployment/deploy-ledger.js";
import { DEPLOYMENT_HEALTH_PATH }
  from "../../../apps/daemon/src/repository/deployment/deployment-infrastructure-templates.js";
import { publicationRepositoryId }
  from "../../../apps/daemon/src/repository/publication-approval-contracts.js";
import { publishAggregateId } from "../../../apps/daemon/src/repository/publish-receipt-contracts.js";
import { resolveRepositoryExecutionIdentity }
  from "../../../apps/daemon/src/repository/repository-execution-identity.js";
import { mintLaneOperatorSeat } from "./daemon-ports.js";
import type { DaemonLane, LaneOperatorSeat } from "./daemon-ports.js";
import { landLaneNode } from "./lane-landing.js";
import { lanePost } from "./lane-preview.js";
import { seededGoalId } from "./lane-preview-arms.js";

/** Admitted by `admitRemoteUrl`; the lane never reaches a network with it. */
const REMOTE_URL = "https://github.com/moe-lane/deploy-rollback-incident.git";

/** Opens the lane's OWN durable store for one read and closes it again, exactly as every other
 *  lane reader does: the daemon owns the file, so nothing here may hold it open across a probe. */
export function withLaneStore<T>(lane: DaemonLane, read: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId);
  try { return read(store); } finally { store.close(); }
}

/**
 * The sha the environment is RUNNING, read through the production ledger reader.
 *
 * A read that throws answers null rather than propagating: this runs inside an HTTP handler the
 * daemon's probe is waiting on, and a busy database there must degrade to "not healthy" - which
 * is a FAILURE probe and therefore the conservative direction - instead of hanging the probe.
 */
export function currentDeploySha(lane: DaemonLane, environment: string): string | null {
  try {
    return withLaneStore(lane,
      (store) => readCurrentDeployReceipt(store, lane.projectId, environment)?.sha ?? null);
  } catch { return null; }
}

export interface LaneEnvironmentEndpoint {
  close(): Promise<void>;
  /**
   * A REAL connect attempt against the bound port. `close()` RETURNING is not evidence the port
   * was released - epic rail 4 asks whether the thing this lane started actually stopped - so the
   * teardown measures it from outside the server object rather than trusting the callback.
   */
  closed(): Promise<boolean>;
  /** Every status this endpoint served, in order. The teardown asserts it actually answered. */
  readonly statuses: readonly number[];
  readonly url: string;
}

/**
 * A loopback HTTP endpoint that answers the daemon's own health path.
 *
 * PORT 0 rather than a scan: the kernel hands back a port nothing else holds, so two lanes on one
 * machine cannot collide. `closeAllConnections` is not optional - the probe uses keep-alive, and
 * `close()` alone would wait out a live socket and leak the port past the test (epic rail 4).
 */
export async function startEnvironmentEndpoint(
  healthy: () => boolean,
): Promise<LaneEnvironmentEndpoint> {
  const statuses: number[] = [];
  const server = createServer((request, response) => {
    const status = request.url === DEPLOYMENT_HEALTH_PATH && healthy() ? 200 : 503;
    statuses.push(status);
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(status === 200 ? "healthy" : "unhealthy");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("LANE_ENDPOINT_UNBOUND");
  const port = String(address.port);
  return Object.freeze({
    close: (): Promise<void> => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
    closed: (): Promise<boolean> => new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      const settle = (isClosed: boolean): void => { socket.destroy(); resolve(isClosed); };
      socket.setTimeout(1_000, () => { settle(false); });
      socket.once("connect", () => { settle(false); });
      socket.once("error", () => { settle(true); });
    }),
    statuses,
    url: `http://127.0.0.1:${port}`,
  });
}

/**
 * One command envelope over the daemon's own `/command`, at the aggregate's CURRENT version.
 *
 * `schemaVersion` is IMPORTED, never a literal, for the reason `lane-preview.ts` gives: a
 * hand-copied version drifts. The seat is the discriminator this spec's authorization arms turn
 * on - ABSENT is the lane credential, which IS the daemon's configured operator; a minted seat is
 * a HUMAN principal that is NOT that operator, the principal class a paired browser holds.
 */
export async function laneCommand(
  lane: DaemonLane, kind: string, aggregateId: string, payload: Record<string, unknown>,
  seat?: LaneOperatorSeat,
): Promise<Record<string, unknown>> {
  const expectedVersion = withLaneStore(lane, (store) => store.getAggregateVersion(aggregateId));
  const credential = seat?.credential ?? lane.credential;
  const answer = await lanePost(lane, "/command", {
    commandId: `lane-rollback-${randomUUID()}`,
    commandKind: kind,
    correlationId: "lane-rollback-incident",
    expectedVersion,
    payload,
    requestDigest: "d".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: credential,
    targetAggregateId: aggregateId,
  }, credential);
  return answer.body;
}

/** The production read the Environments section and the incident queue both poll. */
export async function readLaneHealth(
  lane: DaemonLane, environment: string,
): Promise<Record<string, unknown>> {
  const answer = await lanePost(lane, "/deployments/health/read", { environment });
  return answer.body;
}

/**
 * Drives the deploy's PREREQUISITE to a committed decision and answers the sha git actually holds.
 *
 * HAND-MIRRORED from `deploy-fake-docker.spec.ts` for the reason that spec states: the chain is
 * real end to end - the wrapper's lander commits into the lane's git workspace and records a
 * COMMITTED landing receipt, and the publish is dispatched on a MINTED operator seat because a
 * lane credential is not a HUMAN principal and `publish-services.ts:72` correctly refuses it.
 * Nothing is seeded and no gate is relaxed: a refusal anywhere here fails the test with the
 * daemon's own code.
 */
export async function landAndPublish(lane: DaemonLane, pids: number[]): Promise<string> {
  const landed = await landLaneNode(lane);
  expect(landed.wrapperPid, "the wrapper must report a pid the teardown can assert on")
    .toEqual(expect.any(Number));
  if (landed.wrapperPid !== null) pids.push(landed.wrapperPid);
  expect(landed.ok ? "ok" : `LANDING: ${landed.detail}`).toBe("ok");
  if (!landed.ok) throw new Error("unreachable: the assertion above fails first");
  expect(landed.sha, "the lander commits a real sha git resolves").toMatch(/^[0-9a-f]{40}$/u);
  expect(landed.sha, "the landing moves the workspace head off its baseline")
    .not.toBe(lane.workspaceSha);
  const goalId = await seededGoalId(lane);
  const identity = resolveRepositoryExecutionIdentity(lane.workspace);
  expect(identity.ok, JSON.stringify(identity)).toBe(true);
  if (!identity.ok) throw new Error("unreachable: the assertion above fails first");
  const approval = {
    branch: "main", remoteUrl: REMOTE_URL,
    repositoryId: publicationRepositoryId(identity.identity), sha: landed.sha,
  };
  const answer = await laneCommand(lane, "repository.publish", publishAggregateId(goalId),
    { approval, goalId, remoteUrl: REMOTE_URL }, mintLaneOperatorSeat(lane));
  expect(answer, `PUBLISH: ${JSON.stringify(answer)}`).toMatchObject({ outcome: "ACCEPTED" });
  return landed.sha;
}
