import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { SQLITE_SCHEMA_MANIFEST_VERSION } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { GOAL_ID, PROJECT_ID, closeStores } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composeCutoverActivationMarker,
  deriveCutoverActivationMarkerAggregateId, encodeCutoverActivationMarker,
} from "../cutover/cutover-activation-marker.js";
import { admitV1AuthoritativeCommand } from "../cutover/cutover-v2-authority.js";
import {
  V2_READINESS_MANIFEST_EVENT_TYPE, V2_READINESS_MANIFEST_SCHEMA_VERSION,
  deriveV2ReadinessManifestAggregateId, digestV2ReadinessManifest, encodeV2ReadinessManifest,
} from "../cutover/v2-readiness-manifest.js";
import { V2_SURFACE_MANIFEST_SHA256 } from "../cutover/v2-surface-manifest.js";
import { createDaemonCommandPorts } from "../daemon-command-registry.js";
import { handleAsyncCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { Authenticator } from "../http/http-contract.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { approveGate1, approvePlan, boundWorld, committedRevision, submit }
  from "../planning/plan-reject-test-fixtures.js";
import { createVerifiedWorkspacePort } from "../repository/git-verified-workspace-port.js";
import { readReviewLedger } from "./review-read-model.js";
import { packageItems } from "./review-test-fixtures.js";

const NOW = "2026-08-30T12:05:00.000Z";
const PRINCIPAL = "review-authority-worker";
const folders: string[] = [];
afterEach(() => {
  closeStores();
  for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true });
});
const hex = (digit: string): string => digit.repeat(64);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Exact current readiness/marker records, consumed by the real cutover authority reader. */
function activateV2(store: SqliteEventStore): void {
  const generations = { backupGenerationDigest: hex("1"), distributionManifestSha256: hex("2"),
    importGenerationSha256: hex("3"), quiesceRecordSha256: hex("4") };
  const manifest = { acceptanceEvidenceSha256: hex("5"), backupEvidenceSha256: hex("6"), ...generations,
    contractSchemaSha256: hex("7"), deliveryProfileQualificationEvidenceSha256: hex("8"),
    restoreDrillSha256: hex("9"), schemaVersion: V2_READINESS_MANIFEST_SCHEMA_VERSION,
    securityEvidenceSha256: hex("a"), sourceCommit: "a".repeat(40), storeMigrationEvidenceSha256: hex("b"),
    storeSchemaVersion: SQLITE_SCHEMA_MANIFEST_VERSION, surfaceManifestSha256: V2_SURFACE_MANIFEST_SHA256,
    windowsPackagingEvidenceSha256: hex("c") };
  const commit = (aggregateId: string, commandId: string, eventType: string,
    domainSchemaVersion: string, payload: Uint8Array): void => {
    store.commit({ aggregateId, commandBytes: payload, commandId, committedAt: NOW,
      events: [{ domainSchemaVersion, eventId: `${commandId}-event`, eventType, payload }], expectedVersion: 0 });
  };
  commit(deriveV2ReadinessManifestAggregateId(PROJECT_ID), "review-readiness-v2",
    V2_READINESS_MANIFEST_EVENT_TYPE, manifest.schemaVersion, encodeV2ReadinessManifest(manifest));
  const composed = composeCutoverActivationMarker({ activatedAtEpochMs: 1, generations,
    readinessManifestSha256: digestV2ReadinessManifest(manifest), readinessManifestVersion: 1,
    sourceCommit: manifest.sourceCommit, sourceState: "ACTIVATE_APPROVED" });
  if (!composed.ok) throw new Error("activation marker fixture refused");
  commit(deriveCutoverActivationMarkerAggregateId(PROJECT_ID), "review-activation-v2",
    CUTOVER_ACTIVATION_MARKER_EVENT_TYPE, composed.marker.schemaVersion, encodeCutoverActivationMarker(composed.marker));
  expect(admitV1AuthoritativeCommand(store, { projectId: PROJECT_ID }))
    .toMatchObject({ code: "V1_AUTHORITY_RETIRED", ok: false });
}

function world(flipDuringCapture = false) {
  const store = boundWorld();
  const revision = committedRevision(store);
  approveGate1(store, revision);
  const sealed = submit(store, revision);
  if (!sealed.ok) throw new Error(sealed.code);
  const graph = readGraphBody(store, PROJECT_ID, sealed.graphContentHash);
  if (!graph.ok) throw new Error(graph.code);
  const nodeRef = compiledExecutionRef(PROJECT_ID, {
    content: graph.content, goalRef: GOAL_ID, planningRunRef: sealed.runId,
  }, "node-slice");
  approvePlan(store, sealed.runId);
  const workspace = mkdtempSync(join(tmpdir(), "moe-review-authority-")); folders.push(workspace);
  const git = (...args: string[]): string => execFileSync("git", args, {
    cwd: workspace, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "app.ts"), "export const answer = 42;\n");
  git("add", "--", "app.ts");
  git("-c", "user.name=Review Test", "-c", "user.email=review@test.invalid", "commit", "-qm", "base");
  const authenticator: Authenticator = { authenticate: () => ({ verdict: "AUTHENTICATED", principal: {
    capabilities: ["review.write", "work.write"], principalId: PRINCIPAL, projectId: PROJECT_ID,
  } }) };
  let captures = 0;
  const ports = createDaemonCommandPorts({ clock: () => NOW, operatorPrincipalId: "operator-local",
    projectId: PROJECT_ID, store, reviewSubmission: { workspace, authenticate: authenticator.authenticate,
      capture: async (path) => {
        captures += 1;
        const observed = await createVerifiedWorkspacePort().capture(path);
        if (flipDuringCapture) activateV2(store);
        return observed;
      } } });
  const dispatch = (kind: string, payload: JsonObject, target = nodeRef) => handleAsyncCommandRequest(
    { ...ports, authenticator }, {
      body: new TextEncoder().encode(JSON.stringify({ commandId: `cmd-${kind}`, commandKind: kind,
        correlationId: "review-authority", expectedVersion: 0, payload, requestDigest: sha(JSON.stringify(payload)),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: "test-only", targetAggregateId: target })),
      credential: "test-only", protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_HTTP");
  const claim = () => dispatch("work.claim", { expiresAt: "2026-08-30T13:00:00.000Z",
    workItemId: `node.deliver@${nodeRef}` }, `work/node.deliver@${nodeRef}`);
  return { captures: () => captures, claim, dispatch, git, nodeRef, store };
}

describe("review submission preserves the command authority plane", () => {
  it.each(["explicit legacy", "host prepared"])("refuses %s input before capture after V1 retirement", async (kind) => {
    const w = world(); await w.claim(); activateV2(w.store);
    const horizon = w.store.readEventHorizon();
    const items = kind === "explicit legacy" ? packageItems() as unknown as JsonObject[] : [];
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: items, round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "V1_AUTHORITY_RETIRED", layer: "DAEMON_CUTOVER_V2_AUTHORITY" } });
    expect(w.captures()).toBe(0);
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
    expect(w.store.readEventHorizon()).toBe(horizon);
  });

  it("refuses a V1 command when actual workspace capture spans V2 activation", async () => {
    const w = world(true); await w.claim();
    const head = w.git("rev-parse", "HEAD");
    expect(await w.dispatch("review.submit", { subjectRef: w.nodeRef, findings: [], packageItems: [], round: 1 }))
      .toMatchObject({ ok: false, refusal: { code: "V1_AUTHORITY_RETIRED", layer: "DAEMON_CUTOVER_V2_AUTHORITY" } });
    expect(w.captures()).toBe(1);
    expect(readReviewLedger(w.store, PROJECT_ID, w.nodeRef).rounds).toEqual([]);
    expect(w.git("rev-parse", "HEAD")).toBe(head);
    expect(w.git("status", "--porcelain")).toBe("");
  });
});
