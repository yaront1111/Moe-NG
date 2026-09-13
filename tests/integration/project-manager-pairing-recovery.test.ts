import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createPairingApprovalWindow } from "../../apps/daemon/src/http/pairing-approval-window.js";
import { resolveControlRoomAssetRoot } from "../../apps/daemon/src/http/static-asset-host.js";
import { PROJECT_MANAGER_PROTOCOL_VERSION } from "../../apps/daemon/src/projects/project-manager-http-contract.js";
import { serveProjectManagerRequest } from "../../apps/daemon/src/projects/project-manager-http-routing.js";
import type { ProjectManagerRequestContext } from "../../apps/daemon/src/projects/project-manager-http-routing.js";
import { connectProjectManager } from "../../apps/control-room/src/v2/projects/project-manager-client.js";
import type {
  ProjectManagerConnection, ProjectManagerFetch, ProjectManagerPairingPending,
} from "../../apps/control-room/src/v2/projects/project-manager-client.js";

const SESSION = "isolated-manager-session-0123456789";
const CSRF = "isolated-manager-csrf-0123456789";
const ownedRoots = new Set<string>();

afterEach(() => {
  for (const root of ownedRoots) {
    // Exact native paths returned by this file's own mkdtemp, never caller input.
    rmSync(root, { force: true, recursive: true });
    ownedRoots.delete(root);
  }
});

function savedSession(initial?: string) {
  let value = initial;
  return {
    read: () => value,
    write: vi.fn((credential: string) => { value = credential; }),
    clear: vi.fn(() => { value = undefined; }),
  };
}

function pending(connection: ProjectManagerConnection): ProjectManagerPairingPending {
  if (!("status" in connection) || connection.status !== "AWAITING_OPERATOR") {
    throw new Error("expected a pending pairing request");
  }
  return connection;
}

/** Real pairing kernel and production HTTP routing. Only the project list is a
 * fixture. An ephemeral 127.0.0.1 listener keeps this contract portable to macOS,
 * where the production manager's separate 127.0.0.2 alias is not preconfigured. */
async function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moe-pairing-recovery-")));
  ownedRoots.add(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><title>isolated manager</title>");
  const assets = resolveControlRoomAssetRoot(root, [CSRF, SESSION]);
  if (assets.kind !== "ROOT") throw new Error(assets.code);
  let now = 0;
  const pairing = createPairingApprovalWindow({ now: () => now });
  const list = vi.fn(() => ({ schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION, projects: [] }));
  const mutation = vi.fn(() => { throw new Error("pairing must not mutate a project"); });
  let context: ProjectManagerRequestContext;
  const calls: { path: string; credentialPresent: boolean; status: number }[] = [];
  const server = createServer((request, response) => {
    void serveProjectManagerRequest(request, response, context).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture listener absent");
  const origin = `http://127.0.0.1:${address.port}`;
  context = {
    assets, authority: `127.0.0.1:${address.port}`, csrfToken: CSRF,
    manager: { create: mutation, list, open: mutation, register: mutation, start: mutation, stop: mutation },
    operatorChannelAvailable: () => true, origin, pairing, sessionSecret: SESSION,
  };
  const fetchImpl: ProjectManagerFetch = async (path, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") headers.set("origin", origin);
    const response = await fetch(new URL(path, origin), { ...init, headers });
    calls.push({ path, credentialPresent: headers.has("x-moe-manager-session-credential"),
      status: response.status });
    return response;
  };
  return {
    advanceTo: (instant: number) => { now = instant; },
    approve: (label: string) => pairing.operator.approve(label),
    calls, fetchImpl, list, mutation,
    close: async () => {
      pairing.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

it("preserves the real expiry when approval arrives just before the original deadline", async () => {
  const fixture = await harness();
  const session = savedSession();
  try {
    const pairing = pending(await connectProjectManager({ fetchImpl: fixture.fetchImpl, session }));
    fixture.advanceTo(59_000);
    expect(fixture.approve(pairing.confirmationLabel)).toEqual({ ok: true, state: "APPROVED" });
    fixture.advanceTo(60_000);
    const refused = await pairing.claim();
    expect(fixture.calls.at(-1)).toMatchObject({ path: "/manager/session/pair/claim", status: 410 });
    expect(refused).toEqual({ code: "PAIRING_REQUEST_EXPIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it("restores a claimed session through fresh server validation without another pairing request", async () => {
  const fixture = await harness();
  const session = savedSession();
  try {
    const pairing = pending(await connectProjectManager({ fetchImpl: fixture.fetchImpl, session }));
    fixture.advanceTo(59_000);
    expect(fixture.approve(pairing.confirmationLabel)).toEqual({ ok: true, state: "APPROVED" });
    fixture.advanceTo(59_999);
    const connected = await pairing.claim();
    expect(connected).toMatchObject({ ok: true, projects: [] });
    expect(session.write).toHaveBeenCalledTimes(1);
    expect(session.read()).toBe(SESSION);
    const callsBeforeReload = fixture.calls.length;
    // The request's deadline is over, but an already-claimed manager session is
    // authenticated separately. A fresh client stands in for this tab reloading.
    fixture.advanceTo(60_001);
    const restored = await connectProjectManager({ fetchImpl: fixture.fetchImpl, session });
    expect(restored).toMatchObject({ ok: true, projects: [] });
    expect(restored).not.toBe(connected);
    expect(fixture.calls.slice(callsBeforeReload)).toEqual([
      { path: "/manager/bootstrap", credentialPresent: true, status: 200 },
      { path: "/manager/projects", credentialPresent: true, status: 200 },
    ]);
    expect(fixture.calls.filter(call => call.path === "/manager/session/pair/request")).toHaveLength(1);
    expect(session.write).toHaveBeenCalledTimes(1);
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(fixture.mutation).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it("clears a credential the current manager refuses before creating a new unapproved request", async () => {
  const fixture = await harness();
  const session = savedSession("isolated-stale-session-0123456789");
  try {
    pending(await connectProjectManager({ fetchImpl: fixture.fetchImpl, session }));
    expect(session.clear).toHaveBeenCalledTimes(1);
    expect(session.read()).toBeUndefined();
    expect(session.write).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([
      { path: "/manager/bootstrap", credentialPresent: true, status: 200 },
      { path: "/manager/session/pair/request", credentialPresent: false, status: 200 },
    ]);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});
