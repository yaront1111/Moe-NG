/**
 * The repository-remote read over a REAL store, then over a REAL listener.
 *
 * The view has to distinguish three states that a looser shape would collapse: NOTHING BOUND
 * (every field null, still an `outcome: "REMOTE"` answer), BOUND (the three fields child 1's
 * `readProjectRemote` folded, verbatim) and UNREADABLE (a refusal carrying its own layer). The
 * exact key roster is asserted because the control-room decoder pins it: an extra key is a
 * silent contract change, and a missing one renders as `undefined` rather than refusing.
 */
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readProjectRemote } from "../repository/publish-ledger.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, Authenticator, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  GOOD_CREDENTIAL, authenticator, decisionPort, recordingHandler, registryOf,
} from "./http-test-fixtures.js";
import {
  REPOSITORY_REMOTE_READ_CODES, REPOSITORY_REMOTE_READ_PATH,
  createRepositoryRemoteReadPort, handleRepositoryRemoteReadRequest,
} from "./repository-remote-read.js";
import type { RepositoryRemoteReadPort, RepositoryRemoteView } from "./repository-remote-read.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const NOW = "2026-09-04T10:00:00.000Z";
/** The fixture sequence's clock and principal: what `repository.publish` records as it binds. */
const FIXTURE_BOUND_AT = "2026-08-08T00:00:00.000Z";
const FIXTURE_PRINCIPAL = "principal-1";
const FIXTURE_REMOTE = "https://github.com/fixture/repo.git";
/** The exact roster, restated by hand at the point of use rather than derived from the value. */
const VIEW_KEYS = ["boundAt", "boundBy", "outcome", "readAt", "remoteUrl"] as const;

function view(result: ReturnType<RepositoryRemoteReadPort["readRemote"]>): RepositoryRemoteView {
  if (result.outcome !== "REMOTE") throw new Error(`expected REMOTE, got ${result.code}`);
  return result;
}

describe("createRepositoryRemoteReadPort", () => {
  it("answers nulls, with the exact key roster, while nothing is bound", () => {
    const store = openStore();
    driveThrough(store, "repository.publish");

    const result = createRepositoryRemoteReadPort({ clock: () => NOW, projectId: PROJECT_ID, store }).readRemote();

    expect(result).toEqual({
      boundAt: null, boundBy: null, outcome: "REMOTE", readAt: NOW, remoteUrl: null,
    });
    expect(Object.keys(view(result)).sort()).toEqual([...VIEW_KEYS]);
  });

  it("carries the binding the real publish committed, verbatim", () => {
    const store = openStore();
    // Drives THROUGH `repository.publish` (the sequence stops before `goal.close`), so the
    // binding is written by the production handler, not hand-appended by this test.
    driveThrough(store, "goal.close");

    const result = createRepositoryRemoteReadPort({ clock: () => NOW, projectId: PROJECT_ID, store }).readRemote();

    expect(result).toEqual({
      boundAt: FIXTURE_BOUND_AT, boundBy: FIXTURE_PRINCIPAL, outcome: "REMOTE", readAt: NOW,
      remoteUrl: FIXTURE_REMOTE,
    });
    // `boundBy` is the PRINCIPAL that decided the publish, never the credential it presented.
    expect(view(result).boundBy).not.toBe(GOOD_CREDENTIAL);
  });

  it("keeps two projects on one store from seeing each other's remote", () => {
    const store = openStore();
    driveThrough(store, "goal.close");

    // The aggregate id carries the projectId, so a port bound elsewhere reads nothing at all
    // rather than this project's binding.
    expect(createRepositoryRemoteReadPort({ clock: () => NOW, projectId: "project-2", store }).readRemote())
      .toEqual({ boundAt: null, boundBy: null, outcome: "REMOTE", readAt: NOW, remoteUrl: null });
  });

  it("refuses UNREADABLE, with its own layer, when the fold throws", () => {
    const store = openStore();
    const port = createRepositoryRemoteReadPort({
      clock: () => NOW, projectId: PROJECT_ID,
      readRemote: () => { throw new Error("store gone"); },
      store,
    });

    expect(port.readRemote()).toEqual({
      code: "REPOSITORY_REMOTE_READ_UNREADABLE", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED",
    });
    expect(REPOSITORY_REMOTE_READ_CODES).toEqual([
      "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", "REPOSITORY_REMOTE_READ_PROJECT_MISMATCH",
      "REPOSITORY_REMOTE_READ_UNREADABLE",
    ]);
  });
});

describe("handleRepositoryRemoteReadRequest", () => {
  const port: RepositoryRemoteReadPort = {
    boundProjectId: "proj-0001",
    readRemote: () => ({ code: "REPOSITORY_REMOTE_READ_UNREADABLE", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED" }),
  };
  const request = (body: Uint8Array) => ({ body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });

  it("gates on capability, port presence, project and body, then forwards", () => {
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.PLANNING]), repositoryRemote: port }, request(encoder.encode("{}"))))
      .toEqual({ body: { code: "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toEqual({ code: "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), repositoryRemote: { ...port, boundProjectId: "elsewhere" } }, request(encoder.encode("{}"))))
      .toEqual({ body: { code: "REPOSITORY_REMOTE_READ_PROJECT_MISMATCH", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), repositoryRemote: port }, request(encoder.encode('{"x":1}'))))
      .toEqual({ code: "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    // Both spellings of "no arguments" forward: an empty body and a literal `{}`, the latter
    // with trailing whitespace, which `decodeBoundedJsonBytes` accepts exactly as for sessions.
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), repositoryRemote: port }, request(new Uint8Array())))
      .toEqual({ body: { code: "REPOSITORY_REMOTE_READ_UNREADABLE", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
    expect(handleRepositoryRemoteReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), repositoryRemote: port }, request(encoder.encode("{} \n"))))
      .toMatchObject({ httpStatus: 200, kind: "REPLY" });
  });
});

/**
 * The listener harness, copied from `http-listener.test.ts:49-90` (`withListener`) and
 * `:68-127` (`send`), which are module-private there. Trimmed to what this route needs.
 */
const CSRF = "csrf-token-for-test";

function deps(): CommandAdapterDeps {
  return {
    authenticator: authenticator([CAPABILITIES.GOAL]),
    decisions: decisionPort(),
    eventStreamAccess: { authorize: () => ({ ok: true, subscriberId: "sub-1" }) },
    registry: registryOf("goal.create", recordingHandler().handler, ["title"]),
  };
}

/** The shipped `authenticator` fixture pins `projectId` to "proj-0001"; the real store's
 * binding lives under the bootstrap project, so the end-to-end arm needs a principal scoped
 * to it or every reply would be a PROJECT_MISMATCH that proved nothing about the read. */
function scopedTo(projectId: string): Authenticator {
  return {
    authenticate: (credential: string | null): AuthenticationResult => (credential === GOOD_CREDENTIAL
      ? { principal: { capabilities: [CAPABILITIES.GOAL], principalId: "prin-0001", projectId }, verdict: "AUTHENTICATED" }
      : { verdict: "UNAUTHENTICATED" }),
  };
}

async function withListener(
  run: (listener: ControlRoomListener) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const started = await startControlRoomListener({ csrfToken: CSRF, deps: deps(), ...overrides });
  if (!started.ok) throw new Error(`listener refused to start: ${started.code}`);
  try {
    await run(started);
  } finally {
    await started.close();
  }
}

async function post(
  listener: ControlRoomListener, body: string, method = "POST",
): Promise<{ readonly body: Record<string, unknown>; readonly status: number }> {
  const headers: Record<string, string> = {
    "content-type": "application/json", host: `127.0.0.1:${listener.port}`,
    origin: listener.origin, "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION, "x-moe-session-credential": GOOD_CREDENTIAL,
  };
  return await new Promise((resolve, reject) => {
    const outbound = httpRequest({
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
      host: "127.0.0.1", method, path: REPOSITORY_REMOTE_READ_PATH, port: listener.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>, status: response.statusCode ?? 0 });
      });
    });
    outbound.on("error", reject);
    outbound.end(body);
  });
}

describe("through the real listener", () => {
  const fakePort = {
    boundProjectId: "proj-0001",
    readRemote: () => ({ code: "REPOSITORY_REMOTE_READ_UNREADABLE", layer: "TEST", outcome: "REFUSED" }),
  };

  it("dispatches POST {} to the port, and guards the method and the body", async () => {
    await withListener(async (listener) => {
      // Proves the DISPATCH BRANCH, not just the roster: an unrostered path reaches the asset
      // host instead of a 404, so the discriminator is the port's own answer coming back.
      expect(await post(listener, "{}")).toEqual({
        body: { code: "REPOSITORY_REMOTE_READ_UNREADABLE", layer: "TEST", outcome: "REFUSED" }, status: 200,
      });
      expect((await post(listener, "", "GET")).body["code"]).toBe("LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID");
      expect((await post(listener, JSON.stringify({ x: 1 }))).body["code"]).toBe("LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID");
    }, { repositoryRemote: fakePort });
  });

  it("refuses UNAVAILABLE when the port is not wired", async () => {
    await withListener(async (listener) => {
      expect((await post(listener, "{}")).body["code"]).toBe("LISTENER_REPOSITORY_REMOTE_UNAVAILABLE");
    });
  });

  it("serves the real project's binding end to end", async () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    // A POSITIVE CONTROL for the arm below: the fixture's publish really did bind, so a reply
    // full of nulls would be a defect and not an empty store.
    expect(readProjectRemote(store, PROJECT_ID)).not.toBeNull();
    await withListener(async (listener) => {
      const reply = await post(listener, "{}");
      expect(reply.status).toBe(200);
      expect(Object.keys(reply.body).sort()).toEqual([...VIEW_KEYS]);
      expect(reply.body).toMatchObject({
        boundAt: FIXTURE_BOUND_AT, boundBy: FIXTURE_PRINCIPAL, outcome: "REMOTE", remoteUrl: FIXTURE_REMOTE,
      });
    }, {
      deps: { ...deps(), authenticator: scopedTo(PROJECT_ID) },
      repositoryRemote: createRepositoryRemoteReadPort({ clock: () => NOW, projectId: PROJECT_ID, store }),
    });
  });
});
