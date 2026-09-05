import { describe, expect, it, vi } from "vitest";

import {
  ACTIVATION_FRAME_KEYS, ACTIVATION_MEMBERS, mapActivationAnswer, readActivation,
} from "./live-activation.js";

/**
 * The activation read. Every arm asserts the STABLE CODE and the LAYER of whatever refused,
 * not merely that the decode failed: a frame this reader cannot vouch for must never be
 * half-read into "measured", because a defaulted receipt is a claim the daemon never made.
 */

const LAYER = "CONTROL_ROOM_LIVE_ACTIVATION";

/**
 * The signing reason, as a FIXTURE. Deliberately not the daemon's own literal: that string
 * names the current release version, and tests/integration/release/release-version-surfaces
 * treats every new tracked occurrence of it as an unclassified release surface. What these
 * arms prove is that whatever the daemon states is rendered verbatim, which any string shows.
 */
const SIGNING_REASON = "signing is out of scope for this release";

const measured = (member: string): Record<string, unknown> => ({
  code: null, hash: null, layer: null, measured: true, member,
  reason: `${member} measured`, ref: `${member}/ref`,
});

const missing = (member: string, code: string): Record<string, unknown> => ({
  code, hash: null, layer: "ACTIVATION_RECEIPTS", measured: false, member,
  reason: `${member} is not measured`, ref: null,
});

const SIGNING = {
  measured: false, member: "signing", reason: SIGNING_REASON,
  ref: "signing/unsigned-source-checkout", trustBoundary: false,
};

function frame(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    blocking: [],
    distribution: { kind: "SOURCE_CHECKOUT", root: "D:/projexts/moe-next" },
    measuredAt: "2026-09-05T05:00:00.000Z",
    members: ACTIVATION_MEMBERS.map((member) => measured(member)),
    outcome: "ACTIVATION",
    repository: { headSha: "a".repeat(40), toplevel: "D:/projexts/moe-next" },
    schemaVersion: "moe-activation-receipts/1",
    signing: SIGNING,
    store: { storePath: "D:/store.sqlite" },
    ...overrides,
  };
}

describe("mapActivationAnswer", () => {
  it("shapes the daemon's exact ACTIVATION frame, keeping every reason verbatim", () => {
    const answer = mapActivationAnswer(200, frame());

    expect(answer.status).toBe("ACTIVATION");
    if (answer.status !== "ACTIVATION") return;
    expect(ACTIVATION_FRAME_KEYS).toHaveLength(9);
    expect(answer.members.map((row) => row.member)).toEqual([...ACTIVATION_MEMBERS]);
    expect(answer.members.every((row) => row.measured)).toBe(true);
    expect(answer.members[0]?.reason).toBe("repository measured");
    expect(answer.signing).toEqual({
      measured: false, member: "signing", reason: SIGNING_REASON,
      ref: "signing/unsigned-source-checkout", trustBoundary: false,
    });
    expect(answer.schemaVersion).toBe("moe-activation-receipts/1");
  });

  it("keeps the deferred backup row as a MISSING receipt at the route's own code", () => {
    const deferred = {
      code: "ACTIVATION_READ_BACKUP_DEFERRED", hash: null, layer: "ACTIVATION_READ",
      measured: false, member: "backup",
      reason: "not taken by a read: the store backup is written when project.activate runs",
      ref: null,
    };
    const answer = mapActivationAnswer(200, frame({
      blocking: ["policy"],
      members: [deferred, missing("policy", "ACTIVATION_POLICY_UNMEASURED")],
    }));

    expect(answer.status).toBe("ACTIVATION");
    if (answer.status !== "ACTIVATION") return;
    expect(answer.members[0]).toEqual(deferred);
    // The daemon excludes the deferred backup from `blocking`; the reader repeats that, never widens it.
    expect(answer.blocking).toEqual(["policy"]);
  });

  it("reads a null distribution, repository or store as the UNBOUND STATE, not as malformed", () => {
    const answer = mapActivationAnswer(200, frame({ distribution: null, repository: null, store: null }));

    expect(answer.status).toBe("ACTIVATION");
    if (answer.status !== "ACTIVATION") return;
    expect(answer.distribution).toBeNull();
    expect(answer.repository).toBeNull();
    expect(answer.store).toBeNull();
  });

  it("refuses a frame carrying one key more or one key fewer", () => {
    expect(mapActivationAnswer(200, { ...frame(), extra: 1 }))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
    const { store: _store, ...short } = frame();
    expect(mapActivationAnswer(200, short))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });

  it("refuses a row that claims a measurement while naming the boundary that refused it", () => {
    const contradictory = { ...measured("store"), code: "ACTIVATION_STORE_UNMEASURED", layer: "ACTIVATION_RECEIPTS" };
    expect(mapActivationAnswer(200, frame({ members: [contradictory] })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
    // ...and the mirror: an UNMEASURED row must name a code and a layer, never default them.
    const halfStated = { ...missing("store", "ACTIVATION_STORE_UNMEASURED"), layer: null };
    expect(mapActivationAnswer(200, frame({ members: [halfStated] })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });

  it("refuses a repeated member, and a list longer than the roster", () => {
    // Two rows for one member render two elements under one testid; if they disagreed about
    // `measured` the operator would be shown both, and a card cannot choose between them.
    expect(mapActivationAnswer(200, frame({
      members: [measured("store"), missing("store", "ACTIVATION_STORE_UNMEASURED")],
    }))).toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
    expect(ACTIVATION_MEMBERS).toHaveLength(6);
    const overlong = [...ACTIVATION_MEMBERS, "policy"].map((member) => measured(member));
    expect(mapActivationAnswer(200, frame({ members: overlong })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });

  it("refuses signing that is missing its trustBoundary, and an unknown member name", () => {
    const { trustBoundary: _trust, ...unmarked } = SIGNING;
    expect(mapActivationAnswer(200, frame({ signing: unmarked })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
    expect(mapActivationAnswer(200, frame({ signing: { ...SIGNING, trustBoundary: true } })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
    // `signing` may never arrive as a seventh member.
    expect(mapActivationAnswer(200, frame({ members: [measured("signing")] })))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });

  it("carries the refusing authority's own code and layer, at each of its shapes", () => {
    expect(mapActivationAnswer(503, { code: "LISTENER_ACTIVATION_UNAVAILABLE", layer: "HTTP_LISTENER" }))
      .toEqual({ code: "LISTENER_ACTIVATION_UNAVAILABLE", layer: "HTTP_LISTENER", status: "REFUSED" });
    expect(mapActivationAnswer(200, {
      code: "ACTIVATION_READ_CAPABILITY_DENIED", layer: "ACTIVATION_READ", outcome: "REFUSED",
    })).toEqual({ code: "ACTIVATION_READ_CAPABILITY_DENIED", layer: "ACTIVATION_READ", status: "REFUSED" });
  });

  it("refuses a 200-shaped body under a non-200 status", () => {
    expect(mapActivationAnswer(500, frame()))
      .toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });
});

describe("readActivation", () => {
  it("POSTs exactly {} and returns what the daemon stated", async () => {
    const bodies: string[] = [];
    const post = vi.fn((body: string) => {
      bodies.push(body);
      return Promise.resolve({ json: () => Promise.resolve(frame()), status: 200 } as unknown as Response);
    });

    const answer = await readActivation({ authorization: "Bearer live" }, post);

    expect(bodies).toEqual(["{}"]);
    expect(answer.status).toBe("ACTIVATION");
  });

  it("names the transport when the round trip never delivered, at its own layer", async () => {
    const answer = await readActivation({}, () => Promise.reject(new Error("offline")));
    expect(answer).toEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: LAYER, status: "ERROR" });
  });

  it("refuses a body that is not JSON rather than rendering a blank card", async () => {
    const answer = await readActivation({}, () => Promise.resolve({
      json: () => Promise.reject(new SyntaxError("not json")), status: 200,
    } as unknown as Response));
    expect(answer).toEqual({ code: "ACTIVATION_RESPONSE_INVALID", layer: LAYER, status: "ERROR" });
  });
});
