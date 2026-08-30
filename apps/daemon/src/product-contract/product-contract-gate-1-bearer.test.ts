import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  SESSION_PROOF_MAX_AGE_MS, SESSION_PROOF_MAX_FUTURE_SKEW_MS,
} from "../identity/session-authority-contracts.js";
import {
  commitAuthorityDecision, principalAggregateId, replayAggregateId,
} from "../identity/session-authority-store.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import {
  PRODUCT_CONTRACT_GATE_1_BEARER_CODES, authorizeBearerPresentation,
} from "./product-contract-gate-1-bearer.js";

const PROJECT = "proj-gate-1-bearer";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const COMMAND_ID = "gate-1-bearer-command";
const SUBJECT_DIGEST = createHash("sha256").update("gate-1-subject").digest("hex");
const PROFILE_REVISION_ID = "profile-gate-1-bearer";
const LAYER = "DAEMON_GATE_1_BEARER";
const REPLAY_DOMAIN = "moe/product-contract/gate-1/bearer-replay/v1";

type PrincipalKind = "AGENT" | "HUMAN" | "SYSTEM";

function withStore(run: (store: SqliteEventStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-gate-1-bearer-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function seedPrincipal(store: SqliteEventStore, sessionId: string, kind: PrincipalKind): void {
  const created = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT })
    .createPrincipal({
      commandId: `create-${sessionId}`,
      correlationId: `correlate-${sessionId}`,
      kind,
      principalId: sessionId,
      profileRevisionId: PROFILE_REVISION_ID,
    });
  if (!created.ok) throw new Error(`principal fixture refused: ${created.code}`);
}

function poisonPrincipalRecord(store: SqliteEventStore, sessionId: string): void {
  const committed = commitAuthorityDecision(store, {
    aggregateId: principalAggregateId(sessionId),
    commandId: `poison-${sessionId}`,
    commandKind: "TEST_POISON_PRINCIPAL",
    correlationId: `poison-correlation-${sessionId}`,
    decidedAt: new Date(NOW).toISOString(),
    eventPayload: {},
    eventType: "SessionAuthorityPrincipalCreated",
    expectedVersion: 0,
    principalId: sessionId,
    projectId: PROJECT,
    requestFacts: {},
    resultFacts: {},
  });
  if (!committed.ok) throw new Error(`poison fixture refused: ${committed.code}`);
}

function presentation(
  requestId = COMMAND_ID, requestDigest = SUBJECT_DIGEST, issuedAt = NOW,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ issuedAt, kind: "BEARER", requestId, requestDigest });
}

const INVALID_PRESENTATION_CASES: readonly (readonly [string, unknown])[] = Object.freeze([
  ["an extra key", { ...presentation(), extra: true }],
  ["a missing key", { kind: "BEARER", requestDigest: SUBJECT_DIGEST, requestId: COMMAND_ID }],
  ["a non-bearer kind", { ...presentation(), kind: "SIGNED" }],
  ["null", null],
  ["an array", []],
  ["a negative issuedAt", { ...presentation(), issuedAt: -1 }],
  ["a non-integer issuedAt", { ...presentation(), issuedAt: 1.5 }],
  ["an empty request id", presentation("", SUBJECT_DIGEST)],
  ["an oversized request id", presentation("r".repeat(257), SUBJECT_DIGEST)],
  ["a noncanonical request digest", presentation(COMMAND_ID, "AB".repeat(32))],
]);

interface AuthorizeOverrides {
  readonly commandId?: string;
  readonly grantedAtEpochMs?: number;
  readonly subjectDigest?: string;
}

function authorize(
  store: SqliteEventStore,
  sessionId: string | undefined,
  value: unknown = presentation(),
  overrides: AuthorizeOverrides = {},
) {
  return authorizeBearerPresentation({
    commandId: overrides.commandId ?? COMMAND_ID,
    grantedAtEpochMs: overrides.grantedAtEpochMs ?? NOW,
    presentation: value as never,
    projectId: PROJECT,
    store,
    subjectDigest: overrides.subjectDigest ?? SUBJECT_DIGEST,
    witness: sessionId === undefined
      ? undefined
      : Object.freeze({ sessionId, transportOrigin: "MCP_STDIO" }),
  });
}

function replayDigest(sessionId: string, requestId: string, requestDigest: string): string {
  return createHash("sha256")
    .update([REPLAY_DOMAIN, sessionId, requestId, requestDigest].join("\0"), "utf8")
    .digest("hex");
}

function replayCount(
  store: SqliteEventStore, sessionId: string, requestId = COMMAND_ID,
  requestDigest = SUBJECT_DIGEST,
): number {
  return store.readEvents(replayAggregateId(replayDigest(sessionId, requestId, requestDigest)))
    .filter((event) => event.eventType === "SessionAuthorityReplayObserved").length;
}

describe("Gate 1 bearer admission", () => {
  it("pins the exact nonzero bearer refusal roster", () => {
    expect(PRODUCT_CONTRACT_GATE_1_BEARER_CODES).toEqual([
      "PRODUCT_CONTRACT_GATE_1_BEARER_WITNESS_MISSING",
      "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID",
      "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_STALE",
      "PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT",
      "PRODUCT_CONTRACT_GATE_1_BEARER_KIND_REFUSED",
      "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED",
      "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED",
      "PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE",
    ]);
    expect(PRODUCT_CONTRACT_GATE_1_BEARER_CODES).toHaveLength(8);
    expect(Object.isFrozen(PRODUCT_CONTRACT_GATE_1_BEARER_CODES)).toBe(true);
    expect(INVALID_PRESENTATION_CASES).toHaveLength(10);
    expect(new Set(INVALID_PRESENTATION_CASES.map(([label]) => label)).size).toBe(10);
  });

  it("admits a HUMAN principal and burns exactly one marker for its request identity", () =>
    withStore((store) => {
      const sessionId = "session-bearer-human";
      seedPrincipal(store, sessionId, "HUMAN");
      expect(authorize(store, sessionId)).toEqual({
        facts: { principalId: sessionId, principalKind: "HUMAN" }, ok: true,
      });
      expect(replayCount(store, sessionId)).toBe(1);
    }));

  it.each(["AGENT", "SYSTEM"] as const)(
    "refuses a %s principal without echoing its kind",
    (kind) => withStore((store) => {
      const sessionId = `session-bearer-${kind.toLowerCase()}`;
      seedPrincipal(store, sessionId, kind);
      const refused = authorize(store, sessionId);
      expect(refused).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_KIND_REFUSED", layer: LAYER, ok: false,
      });
      expect(JSON.stringify(refused)).not.toContain(kind);
      expect(replayCount(store, sessionId)).toBe(0);
    }),
  );

  it("refuses a witness with no SessionAuthority principal record", () => withStore((store) => {
    const sessionId = "session-bearer-absent";
    expect(authorize(store, sessionId)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRINCIPAL_ABSENT", layer: LAYER, ok: false,
    });
    expect(replayCount(store, sessionId)).toBe(0);
  }));

  it("refuses an unreadable principal identity without granting authority", () => withStore((store) => {
    const sessionId = "session-bearer-unreadable";
    poisonPrincipalRecord(store, sessionId);
    expect(authorize(store, sessionId)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE", layer: LAYER, ok: false,
    });
    expect(replayCount(store, sessionId)).toBe(0);
  }));

  it("refuses when the replay ledger is unreadable after the HUMAN lookup", () =>
    withStore((store) => {
      const sessionId = "session-bearer-replay-unreadable";
      seedPrincipal(store, sessionId, "HUMAN");
      const unreadable = new Proxy(store, {
        get: (target, property): unknown => {
          if (property === "getCommandDecision") {
            return (): never => { throw new Error("replay decision read unavailable"); };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(authorize(unreadable, sessionId)).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_UNREADABLE", layer: LAYER, ok: false,
      });
      expect(replayCount(store, sessionId)).toBe(0);
    }));

  it("refuses a presentation without a server-assembled witness", () => withStore((store) => {
    expect(authorize(store, undefined)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_WITNESS_MISSING", layer: LAYER, ok: false,
    });
  }));

  it.each([
    ["request id", presentation("other-command"), COMMAND_ID, SUBJECT_DIGEST],
    ["subject digest", presentation(COMMAND_ID, "f".repeat(64)), COMMAND_ID, SUBJECT_DIGEST],
  ] as const)("refuses a mismatched %s before burning", (_label, value, commandId, digest) =>
    withStore((store) => {
      const sessionId = `session-binding-${_label.replace(" ", "-")}`;
      seedPrincipal(store, sessionId, "HUMAN");
      expect(authorize(store, sessionId, value, { commandId, subjectDigest: digest })).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID", layer: LAYER, ok: false,
      });
      expect(replayCount(store, sessionId, String(value["requestId"]), String(value["requestDigest"])))
        .toBe(0);
    }));

  it.each([
    ["one millisecond too old", NOW - SESSION_PROOF_MAX_AGE_MS - 1, false],
    ["one millisecond too far in the future", NOW + SESSION_PROOF_MAX_FUTURE_SKEW_MS + 1, false],
    ["exactly at the age bound", NOW - SESSION_PROOF_MAX_AGE_MS, true],
    ["exactly at the future-skew bound", NOW + SESSION_PROOF_MAX_FUTURE_SKEW_MS, true],
  ] as const)("applies TTL at %s", (_label, issuedAt, accepted) => withStore((store) => {
    const sessionId = `session-ttl-${issuedAt}`;
    seedPrincipal(store, sessionId, "HUMAN");
    const result = authorize(store, sessionId, presentation(COMMAND_ID, SUBJECT_DIGEST, issuedAt));
    if (accepted) expect(result).toMatchObject({ ok: true });
    else expect(result).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_STALE", layer: LAYER, ok: false,
    });
  }));

  it("refuses the same burn twice while admitting a fresh request identity", () =>
    withStore((store) => {
      const sessionId = "session-bearer-replay";
      seedPrincipal(store, sessionId, "HUMAN");
      expect(authorize(store, sessionId)).toMatchObject({ ok: true });
      expect(authorize(store, sessionId)).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_REPLAYED", layer: LAYER, ok: false,
      });
      expect(replayCount(store, sessionId)).toBe(1);

      const freshId = "gate-1-bearer-command-fresh";
      const freshDigest = createHash("sha256").update("fresh-subject").digest("hex");
      expect(authorize(store, sessionId, presentation(freshId, freshDigest), {
        commandId: freshId, subjectDigest: freshDigest,
      })).toMatchObject({ ok: true });
      expect(replayCount(store, sessionId, freshId, freshDigest)).toBe(1);
    }));

  it.each(INVALID_PRESENTATION_CASES)(
    "refuses %s as an invalid presentation", (_label, value) => withStore((store) => {
    const sessionId = `session-shape-${_label.replaceAll(" ", "-")}`;
    seedPrincipal(store, sessionId, "HUMAN");
    expect(authorize(store, sessionId, value)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID", layer: LAYER, ok: false,
    });
    }),
  );

  it("refuses an accessor presentation without invoking it", () => withStore((store) => {
    const sessionId = "session-shape-accessor";
    seedPrincipal(store, sessionId, "HUMAN");
    let reads = 0;
    const value = { kind: "BEARER", requestDigest: SUBJECT_DIGEST, requestId: COMMAND_ID };
    Object.defineProperty(value, "issuedAt", {
      enumerable: true, get: () => { reads += 1; return NOW; },
    });
    expect(authorize(store, sessionId, value)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_PRESENTATION_INVALID", layer: LAYER, ok: false,
    });
    expect(reads).toBe(0);
  }));
});
