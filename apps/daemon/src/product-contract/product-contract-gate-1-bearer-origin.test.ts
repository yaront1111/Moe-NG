import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { TRANSPORT_ORIGINS } from "../http/http-contract.js";
import type { TransportOrigin } from "../http/http-contract.js";
import { createSessionAuthority } from "../identity/session-authority.js";
import {
  PRODUCT_CONTRACT_GATE_1_BEARER_ORIGINS, authorizeBearerPresentation,
} from "./product-contract-gate-1-bearer.js";

const PROJECT = "proj-gate-1-bearer-origin";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const LAYER = "DAEMON_GATE_1_BEARER";
const SURVIVORS: readonly TransportOrigin[] = Object.freeze(["MCP_STDIO", "MCP_HTTP"]);

function withStore(run: (store: SqliteEventStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-gate-1-bearer-origin-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function seedHuman(store: SqliteEventStore, sessionId: string): void {
  const created = createSessionAuthority(store, { clock: () => NOW, projectId: PROJECT })
    .createPrincipal({
      commandId: `create-${sessionId}`,
      correlationId: `correlate-${sessionId}`,
      kind: "HUMAN",
      principalId: sessionId,
      profileRevisionId: "profile-gate-1-origin",
    });
  if (!created.ok) throw new Error(`principal fixture refused: ${created.code}`);
}

function authorize(
  store: SqliteEventStore,
  sessionId: string,
  transportOrigin?: TransportOrigin,
  presentationOrigin?: TransportOrigin,
) {
  const commandId = `command-${sessionId}`;
  const subjectDigest = createHash("sha256").update(`subject-${sessionId}`).digest("hex");
  const witness = transportOrigin === undefined
    ? Object.freeze({ sessionId })
    : Object.freeze({ sessionId, transportOrigin });
  const presentation = Object.freeze({
    issuedAt: NOW, kind: "BEARER" as const, requestDigest: subjectDigest, requestId: commandId,
    ...(presentationOrigin === undefined ? {} : { transportOrigin: presentationOrigin }),
  });
  return authorizeBearerPresentation({
    commandId,
    grantedAtEpochMs: NOW,
    presentation,
    projectId: PROJECT,
    store,
    subjectDigest,
    witness,
  });
}

describe("Gate 1 bearer transport-origin fence", () => {
  it("exports the exact frozen non-browser survivor roster", () => {
    expect(PRODUCT_CONTRACT_GATE_1_BEARER_ORIGINS).toEqual(["MCP_STDIO", "MCP_HTTP"]);
    expect(Object.isFrozen(PRODUCT_CONTRACT_GATE_1_BEARER_ORIGINS)).toBe(true);
  });

  it("admits exactly the named origins when every other check passes", () => withStore((store) => {
    const admitted: TransportOrigin[] = [];
    expect(TRANSPORT_ORIGINS).toHaveLength(5);

    for (const origin of TRANSPORT_ORIGINS) {
      const sessionId = `session-${origin.toLowerCase()}`;
      seedHuman(store, sessionId);
      const result = authorize(store, sessionId, origin);
      if (result.ok) {
        admitted.push(origin);
      } else {
        expect(result).toEqual({
          code: "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED", layer: LAYER, ok: false,
        });
      }
    }

    expect(admitted.sort()).toEqual([...SURVIVORS].sort());
  }));

  it("refuses a browser-origin bearer without consuming its otherwise valid request", () =>
    withStore((store) => {
      const sessionId = "session-browser-divergence";
      seedHuman(store, sessionId);

      expect(authorize(store, sessionId, "HTTP_LISTENER")).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED", layer: LAYER, ok: false,
      });
      expect(authorize(store, sessionId, "MCP_STDIO")).toEqual({
        facts: { principalId: sessionId, principalKind: "HUMAN" }, ok: true,
      });
    }));

  it.each(SURVIVORS)("keeps the %s bearer survivor authenticating", (origin) =>
    withStore((store) => {
      const sessionId = `session-survivor-${origin.toLowerCase()}`;
      seedHuman(store, sessionId);
      expect(authorize(store, sessionId, origin)).toEqual({
        facts: { principalId: sessionId, principalKind: "HUMAN" }, ok: true,
      });
    }));

  it("refuses a legacy witness with no server-authored origin", () => withStore((store) => {
    const sessionId = "session-origin-missing";
    seedHuman(store, sessionId);
    expect(authorize(store, sessionId)).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED", layer: LAYER, ok: false,
    });
  }));

  it("refuses a browser origin before observing an absent principal", () => withStore((store) => {
    expect(authorize(store, "session-origin-denied-before-principal", "HTTP_LISTENER")).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED", layer: LAYER, ok: false,
    });
  }));

  it("does not let a presentation-carried origin override the server witness", () =>
    withStore((store) => {
      const sessionId = "session-presentation-origin-smuggle";
      seedHuman(store, sessionId);
      expect(authorize(store, sessionId, "HTTP_LISTENER", "MCP_STDIO")).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_BEARER_ORIGIN_REFUSED", layer: LAYER, ok: false,
      });
    }));
});
