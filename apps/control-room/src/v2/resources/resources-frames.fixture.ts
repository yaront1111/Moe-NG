import { expect } from "vitest";

import { mapActivationAnswer } from "../../live/live-activation.js";
import type { ActivationReadOutcome } from "../../live/live-activation.js";
import { mapHealthAnswer, mapPolicyAnswer } from "../../live/live-ops.js";
import type { HealthOutcome, PolicyOutcome } from "../../live/live-ops.js";
import { mapRepositoryRemoteAnswer } from "../../live/live-repository-remote.js";
import type { RepositoryRemoteOutcome } from "../../live/live-repository-remote.js";
import { mapSessionsAnswer } from "../../live/live-sessions.js";
import type { SessionsOutcome } from "../../live/live-sessions.js";
import type { ResourceReads } from "./resources-model.js";

/**
 * THE FIVE DAEMON FRAMES THE RESOURCES SCREEN FOLDS, AND THE DECODERS THAT VET THEM.
 *
 * Nothing here reaches a screen as a hand-written object. Every frame is put through the
 * PRODUCTION decoder - `mapActivationAnswer` and friends - whose exact-key, exact-arity
 * snapshots reject a body that is not shaped the way the daemon serves it, and `decoded()`
 * asserts the decode produced the SUCCESS arm. A frame that drifts from the daemon fails
 * HERE, loudly, instead of degrading into a refusal and leaving a green test that renders
 * error rows and asserts nothing about the facts it claims to cover.
 *
 * Shapes are taken from the routes themselves: apps/daemon/src/http/activation-read.ts
 * (nine frame keys, seven per receipt, five on signing), health-read.ts, policy-read.ts,
 * sessions-read.ts and repository-remote-read.ts, cross-checked against the committed
 * activation frame at v2/cordum-app.test.tsx.
 */

export function decoded<T extends { readonly status: string }>(
  map: (status: number, response: unknown) => T, body: unknown, expected: T["status"],
): T {
  const outcome = map(200, body);
  expect(outcome.status).toBe(expected);
  return outcome;
}

/**
 * A refusal envelope as the listener writes it, vetted the same way: the arm asserts the
 * decoder really read it AS a refusal carrying these exact bytes, so a test cannot be
 * driven by some other error the decoder invented for a frame it failed to recognise.
 */
export function refusalOf<T>(
  map: (status: number, response: unknown) => T, code: string, layer: string, expected: string,
): T {
  const outcome = map(200, { code, layer });
  expect((outcome as { readonly status: string }).status).toBe(expected);
  expect(outcome).toMatchObject({ code, layer });
  return outcome;
}

export const STORE_PATH = "D:/projexts/moe-next/.moe-next/store.sqlite";
export const REPO_ROOT = "D:/projexts/moe-next";
export const HEAD_SHA = "b".repeat(40);
export const REMOTE_URL = "https://github.com/cordum/moe-next.git";

/** The credential VALUE the provider section must never render, in any arm. */
export const CREDENTIAL_VALUE = "sk-ant-api03-hFqQ2Zj8L4nR7wVxYbT1cMe6PkA9sDgU0iOyHlXnBvCzKtRfWq";

export const ACTIVATION_BODY = {
  blocking: [],
  distribution: { kind: "SOURCE_CHECKOUT", root: REPO_ROOT },
  measuredAt: "2026-09-05T05:00:00.000Z",
  members: [
    {
      code: null, hash: "b".repeat(64), layer: null, measured: true, member: "repository",
      reason: "HEAD is at b1b1b1b1", ref: "repo/head",
    },
    {
      code: null, hash: null, layer: null, measured: true, member: "provider",
      reason: "claude is on PATH", ref: "credential/claude/env:ANTHROPIC_AUTH_TOKEN",
    },
    {
      code: null, hash: null, layer: null, measured: true, member: "store",
      reason: "the store opened", ref: "store/sqlite",
    },
    {
      code: "ACTIVATION_READ_BACKUP_DEFERRED", hash: null, layer: "ACTIVATION_READ",
      measured: false, member: "backup",
      reason: "not taken by a read: the store backup is written when project.activate runs",
      ref: null,
    },
    {
      code: null, hash: null, layer: null, measured: true, member: "distribution",
      reason: "a source checkout", ref: "dist/source-checkout",
    },
    {
      code: null, hash: null, layer: null, measured: true, member: "policy",
      reason: "policy is installed", ref: "policy/3",
    },
  ],
  outcome: "ACTIVATION",
  repository: { headSha: HEAD_SHA, toplevel: REPO_ROOT },
  schemaVersion: "moe-activation-receipts/1",
  signing: {
    measured: false, member: "signing", reason: "signing is out of scope for this release",
    ref: "signing/unsigned-source-checkout", trustBoundary: false,
  },
  store: { storePath: STORE_PATH },
};

const HEALTH_BODY = {
  agents: { paused: null },
  daemon: {
    commandAuthorityPlane: "V2", nodeSpecsDir: null, pid: 54_924, projectId: "proj-dd087108",
    protocolVersion: "moe-daemon/1", startedAt: "2026-09-05T04:00:00.000Z", storePath: STORE_PATH,
  },
  ledger: {
    aggregates: 41, commandKinds: 19, decisionCount: 812, goals: 6,
    lastDecidedAt: "2026-09-05T04:58:00.000Z",
  },
  outcome: "HEALTH",
  readAt: "2026-09-05T05:00:00.000Z",
  verifier: { calibration: true, policy: true },
};

const POLICY_BODY = {
  aggregateVersion: 7,
  evaluations: [],
  outcome: "POLICY",
  slices: [],
  standard: [],
  verifier: { calibration: true, policy: true },
  waivers: { reason: "No command on this daemon records a policy waiver.", supported: false },
};

const SESSIONS_BODY = {
  concurrency: { activeSeats: 2, configuredAgentLimit: 4 },
  outcome: "SESSIONS",
  readAt: "2026-09-05T05:00:00.000Z",
  sessions: [],
  totals: { closed: 0, expired: 0, live: 2 },
  unreadable: false,
};

const REMOTE_BODY = {
  boundAt: "2026-09-04T12:00:00.000Z",
  boundBy: "operator-local",
  outcome: "REMOTE",
  readAt: "2026-09-05T05:00:00.000Z",
  remoteUrl: REMOTE_URL,
};

/** The health frame with an EMPTY store path: the decoder accepts it, so the screen must handle it. */
export const HEALTH_EMPTY_STORE_BODY = {
  ...HEALTH_BODY, daemon: { ...HEALTH_BODY.daemon, storePath: "" },
};

export const activation = (body: unknown = ACTIVATION_BODY): ActivationReadOutcome =>
  decoded(mapActivationAnswer, body, "ACTIVATION");
export const health = (): HealthOutcome => decoded(mapHealthAnswer, HEALTH_BODY, "HEALTH");
export const policy = (): PolicyOutcome => decoded(mapPolicyAnswer, POLICY_BODY, "POLICY");
export const sessions = (): SessionsOutcome => decoded(mapSessionsAnswer, SESSIONS_BODY, "SESSIONS");
export const remote = (): RepositoryRemoteOutcome =>
  decoded(mapRepositoryRemoteAnswer, REMOTE_BODY, "REMOTE");

/** Every read answering. */
export const allRead = (): ResourceReads => ({
  activation: activation(), health: health(), policy: policy(), remote: remote(), sessions: sessions(),
});

/** The activation frame with the provider receipt's fields replaced wholesale. */
export const withProviderReceipt = (receipt: Readonly<Record<string, unknown>>): unknown => ({
  ...ACTIVATION_BODY,
  members: ACTIVATION_BODY.members.map((row) => (row.member === "provider" ? receipt : row)),
});
