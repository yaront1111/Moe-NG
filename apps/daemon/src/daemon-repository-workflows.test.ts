import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { createStoreDependencies } from "./daemon-store-dependencies.js";
import { startDaemon } from "./daemon-entry.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { installTestRecoveryBinding } from "./identity/session-test-fixtures.js";
import { createRepositoryExecutionPort } from "./repository/repository-execution-port.js";
const CSRF = "workflow-test-csrf";
async function request(origin: string, credential: string, path: string, body: unknown, method = "POST") {
  const url = new URL(path, origin); const text = JSON.stringify(body);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text),
      origin, "x-moe-csrf": CSRF, "x-moe-protocol-version": WIRE_PROTOCOL_VERSION, "x-moe-session-credential": credential } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    }); req.setTimeout(10_000, () => req.destroy(new Error(`workflow route timeout: ${path}`))); req.on("error", reject); req.end(text);
  });
}
it("normal daemon entry serves a paired human's exact recovery offer and releases only that unused owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-workflow-http-"));
  const workspace = join(directory, "repo"); mkdirSync(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, windowsHide: true, stdio: "pipe" });
  git("init", "--quiet", "-b", "main"); writeFileSync(join(workspace, "file.txt"), "baseline\n"); git("add", "--", "file.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "baseline");
  const projectId = "workflow-project", storePath = join(directory, "store.db");
  const provider = createStoreDependencies({ credential: "workflow-operator", principalId: "operator", projectId, storePath, repositoryWorkspace: workspace });
  const store = SqliteEventStore.openForProject(storePath, projectId); installTestRecoveryBinding(store);
  const human = provider.sessionHandshake?.().mint();
  if (human === undefined || !human.ok) throw new Error("human session unavailable");
  const repository = createRepositoryExecutionPort();
  const held = repository.acquire(workspace, { projectId, nodeRef: "unused-node", storeId: realpathSync.native(storePath), ownershipToken: "a".repeat(64) },
    { controllerId: "test-controller", controllerPid: process.pid });
  expect(held.ok).toBe(true);
  const started = await startDaemon({ dependencies: provider, csrfToken: CSRF });
  if (!started.ok) throw new Error(started.code);
  try {
    const denied = await request(started.origin, "wrong-session", "/repository/recovery/read", {});
    expect(denied.status).toBe(401);
    const read = await request(started.origin, human.credential, "/repository/recovery/read", {});
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain("ownershipToken"); expect(JSON.stringify(read.body)).not.toContain("controllerPid");
    const reservations = read.body["reservations"] as { nodeRef: string; expectedReservationRevision: number; actions: { action: string; offer: Record<string, unknown> | null }[] }[];
    expect(reservations).toHaveLength(1);
    const reservation = reservations[0]!; const offer = reservation.actions.find((row) => row.action === "ABORT_UNEXECUTED")?.offer;
    expect(offer).not.toBeNull(); if (offer === undefined || offer === null) throw new Error("abort was not offered");
    const payload = { action: "ABORT_UNEXECUTED", decision: "APPROVE", nodeRef: reservation.nodeRef,
      expectedReservationRevision: reservation.expectedReservationRevision, reason: "Confirmed no execution started" };
    const command = { schemaVersion: offer["commandEnvelopeVersion"], commandKind: offer["commandKind"], commandId: offer["commandId"],
      targetAggregateId: offer["targetAggregateId"], expectedVersion: offer["expectedVersion"], correlationId: "workflow-http",
      sessionCredential: human.credential, requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload };
    const accepted = await request(started.origin, human.credential, "/command", command);
    expect(accepted.body).toMatchObject({ ok: true, decision: { resultCode: "REPOSITORY_RECOVERY_RELEASED" } });
    expect(repository.inspect(workspace)).toMatchObject({ ok: true, reservation: null });
    const criteria = await request(started.origin, human.credential, "/criteria/read", { goalRef: "missing-goal" });
    expect(criteria.body).toMatchObject({ outcome: "REFUSED", layer: "CRITERION_EVIDENCE" });
    expect((await request(started.origin, human.credential, "/criteria/read", { goalRef: "missing-goal" }, "GET")).body)
      .toMatchObject({ code: "LISTENER_CRITERIA_REQUEST_INVALID" });
  } finally {
    await started.shutdown(); store.close(); provider.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30000);
