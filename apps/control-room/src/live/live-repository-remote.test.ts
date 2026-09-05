import { describe, expect, it } from "vitest";

import { REPOSITORY_REMOTE_FRAME_KEYS, mapRepositoryRemoteAnswer, readRepositoryRemote } from "./live-repository-remote.js";

/**
 * The two frames below are RECORDED, not invented: both were printed by the daemon's own
 * production port, `createRepositoryRemoteReadPort(...).readRemote()` from
 * apps/daemon/src/http/repository-remote-read.ts, run under node type-stripping on 2026-09-05
 * with a bound reader and with a null reader. Their key order is the recorded order.
 *
 *   BOUND   {"boundAt":"2026-09-05T04:33:07.118Z","boundBy":"operator-local","outcome":"REMOTE",
 *            "readAt":"2026-09-05T04:41:12.503Z","remoteUrl":"https://github.com/owner/unai.git"}
 *   UNBOUND {"boundAt":null,"boundBy":null,"outcome":"REMOTE",
 *            "readAt":"2026-09-05T04:41:12.907Z","remoteUrl":null}
 */
const BOUND = Object.freeze({
  boundAt: "2026-09-05T04:33:07.118Z", boundBy: "operator-local", outcome: "REMOTE",
  readAt: "2026-09-05T04:41:12.503Z", remoteUrl: "https://github.com/owner/unai.git",
});
const UNBOUND = Object.freeze({
  boundAt: null, boundBy: null, outcome: "REMOTE", readAt: "2026-09-05T04:41:12.907Z", remoteUrl: null,
});
const response = (status: number, body: unknown): Response => ({ json: async () => body, status } as unknown as Response);

describe("mapRepositoryRemoteAnswer", () => {
  it("pins the daemon's five-key REMOTE frame, so a shape drift cannot pass silently", () => {
    expect([...REPOSITORY_REMOTE_FRAME_KEYS]).toStrictEqual(["boundAt", "boundBy", "outcome", "readAt", "remoteUrl"]);
    expect(Object.keys(BOUND).sort()).toStrictEqual([...REPOSITORY_REMOTE_FRAME_KEYS]);
  });

  it("maps the recorded BOUND frame verbatim", () => {
    expect(mapRepositoryRemoteAnswer(200, BOUND)).toStrictEqual({
      boundAt: "2026-09-05T04:33:07.118Z", boundBy: "operator-local", readAt: "2026-09-05T04:41:12.503Z",
      remoteUrl: "https://github.com/owner/unai.git", status: "REMOTE",
    });
  });

  it("maps the recorded all-null UNBOUND frame as REMOTE, never as malformed", () => {
    const outcome = mapRepositoryRemoteAnswer(200, UNBOUND);
    expect(outcome.status).toBe("REMOTE");
    expect(outcome).toStrictEqual({
      boundAt: null, boundBy: null, readAt: "2026-09-05T04:41:12.907Z", remoteUrl: null, status: "REMOTE",
    });
  });

  it("REFUSES a frame with an extra key, a missing key, or a non-REMOTE outcome", () => {
    const extra = mapRepositoryRemoteAnswer(200, { ...BOUND, credential: "ghp_secret" });
    expect(extra).toStrictEqual({
      code: "REPOSITORY_REMOTE_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_REPOSITORY_REMOTE", status: "ERROR",
    });
    const { boundBy: _dropped, ...missing } = BOUND;
    expect(mapRepositoryRemoteAnswer(200, missing).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(200, { ...BOUND, outcome: "REMOTES" }).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(200, { ...BOUND, readAt: "" }).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(200, { ...BOUND, remoteUrl: 7 }).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(200, { ...BOUND, boundAt: "" }).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(200, null).status).toBe("ERROR");
    expect(mapRepositoryRemoteAnswer(500, BOUND).status).toBe("ERROR");
  });

  it("carries the daemon's own refusal code and layer through, at each refusal shape", () => {
    expect(mapRepositoryRemoteAnswer(200, {
      code: "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", layer: "REPOSITORY_REMOTE_READ", outcome: "REFUSED",
    })).toStrictEqual({
      code: "REPOSITORY_REMOTE_READ_CAPABILITY_DENIED", layer: "REPOSITORY_REMOTE_READ", status: "REFUSED",
    });
    expect(mapRepositoryRemoteAnswer(200, {
      code: "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE", layer: "DAEMON_LISTENER",
    })).toStrictEqual({ code: "LISTENER_REPOSITORY_REMOTE_UNAVAILABLE", layer: "DAEMON_LISTENER", status: "REFUSED" });
    expect(mapRepositoryRemoteAnswer(401, {
      error: { code: "SESSION_CREDENTIAL_INVALID" }, httpStatus: 401, ok: false, outcome: "REFUSED", stage: "DAEMON_INGRESS",
    })).toStrictEqual({ code: "SESSION_CREDENTIAL_INVALID", layer: "DAEMON_INGRESS", status: "REFUSED" });
  });
});

describe("readRepositoryRemote", () => {
  it("POSTs exactly {} and maps the reply", async () => {
    const bodies: string[] = [];
    const outcome = await readRepositoryRemote({ "x-moe-session": "s" }, async (body) => {
      bodies.push(body);
      return response(200, BOUND);
    });
    expect(bodies).toStrictEqual(["{}"]);
    expect(outcome).toStrictEqual({
      boundAt: "2026-09-05T04:33:07.118Z", boundBy: "operator-local", readAt: "2026-09-05T04:41:12.503Z",
      remoteUrl: "https://github.com/owner/unai.git", status: "REMOTE",
    });
  });

  it("names the transport when the request never reached the daemon, and the body when it is unreadable", async () => {
    await expect(readRepositoryRemote({}, async () => { throw new Error("offline"); })).resolves.toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_REPOSITORY_REMOTE", status: "ERROR",
    });
    const unreadable = await readRepositoryRemote({}, async () => ({
      json: async () => { throw new Error("not json"); }, status: 200,
    } as unknown as Response));
    expect(unreadable).toStrictEqual({
      code: "REPOSITORY_REMOTE_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_REPOSITORY_REMOTE", status: "ERROR",
    });
  });
});
