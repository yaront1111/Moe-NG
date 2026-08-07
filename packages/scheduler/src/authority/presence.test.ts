import { describe, expect, it } from "vitest";

import { acceptPing, openPresence, type PresencePing } from "./presence.js";

function projection(lastSeen = 100, lastPingId: string | null = "ping-0") {
  return { sessionRef: "session-1", lastSeen, lastPingId };
}
function ping(over: Partial<PresencePing> = {}): PresencePing {
  return {
    sessionRef: "session-1", pingId: "ping-1", clientObservation: "client-observed-1",
    serverReceivedAt: 140, ...over,
  };
}

describe("presence is separate and non-authoritative (design 12.3)", () => {
  it("opens a projection carrying nothing but a session reference and lastSeen", () => {
    const result = openPresence("session-1", 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection).toEqual({ sessionRef: "session-1", lastSeen: 10, lastPingId: null });
    expect(Object.keys(result.projection).sort())
      .toEqual(["lastPingId", "lastSeen", "sessionRef"]);
    expect(Object.isFrozen(result.projection)).toBe(true);
  });

  it("advances lastSeen to the server-observed maximum", () => {
    const result = acceptPing(projection(100), ping({ serverReceivedAt: 140 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.lastSeen).toBe(140);
    expect(result.projection.lastPingId).toBe("ping-1");
  });

  it("never moves lastSeen backwards when a delayed ping arrives", () => {
    const result = acceptPing(projection(200), ping({ serverReceivedAt: 140 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.lastSeen).toBe(200);
  });

  it("is idempotent on ping id, even for a later server timestamp", () => {
    const first = acceptPing(projection(100), ping());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replayed = acceptPing(first.projection, ping({ serverReceivedAt: 9_000 }));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.projection).toEqual(first.projection);
  });

  it("refuses a ping addressed to a different session", () => {
    const result = acceptPing(projection(), ping({ sessionRef: "session-2" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PRESENCE_SESSION_MISMATCH");
  });

  const malformed: readonly (readonly [string, unknown, unknown])[] = [
    ["a null projection", null, ping()],
    ["an unknown projection key", { ...projection(), epoch: 3 }, ping()],
    ["a negative lastSeen", { ...projection(), lastSeen: -1 }, ping()],
    ["an empty ping id", projection(), { ...ping(), pingId: "" }],
    ["a non-integer server timestamp", projection(), { ...ping(), serverReceivedAt: 1.5 }],
    ["an extra ping field", projection(), { ...ping(), leaseToken: "token-current" }],
    ["a missing client observation", projection(), { sessionRef: "session-1", pingId: "p" }],
  ];
  for (const [name, current, envelope] of malformed) {
    it(`refuses ${name}`, () => {
      const result = acceptPing(current, envelope);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PRESENCE_MALFORMED_INPUT");
    });
  }

  it("exposes no field that could carry lease authority", () => {
    const result = acceptPing(projection(), ping());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.projection);
    for (const forbidden of ["epoch", "leaseToken", "version", "state", "authorityHashRef"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
