/**
 * `graph.preview`, served through the SAME authenticated query path as
 * `graph.get`, over a REAL file-backed SqliteEventStore and a REAL
 * `Authenticator`.
 *
 * WHY THESE ASSERTIONS AND NOT AN EQUATION. The preview evaluator already
 * exists and is already exercised by its own suite; what is unproven is the
 * WIRING — that the shared gate runs before the payload is looked at, that the
 * evaluator's own advisory envelope survives the transport unrestamped, and
 * that serving it reads nothing durable. So every expected value here comes
 * from running the PRODUCTION evaluator over the same bytes in-process
 * (`evaluateGraphPreviewRequestBytes`), never from transcribed output: a test
 * holding both operands would agree with itself no matter what the port did.
 *
 * TWO LAYERS CAN REFUSE HERE and the assertions have to tell them apart (epic
 * rail 6). The shared gate refuses with a GRAPH_QUERY code and that layer
 * name; the evaluator refuses with its own advisory envelope carrying
 * `authority: "NONE"` and no layer at all. A restamp of one into the other is
 * invisible to any test that only checks "it was refused".
 *
 * WINDOWS HANDLE DISCIPLINE: `withStore` closes the store in a `finally` inside
 * the temp directory's own `finally`. A handle held across `rmSync` throws
 * EPERM and kills the vitest worker with no output at all.
 */

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { evaluateGraphPreviewRequestBytes } from "../graph-preview-request.js";
import { createMcpDispatchPort } from "../mcp-dispatch-port.js";
import { MCP_SERVED_QUERY_KINDS, wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import type { AuthenticatedPrincipal } from "../http/http-contract.js";
import type { HttpDispatchPort } from "@moe/mcp";
import { streamPort } from "../http/event-stream-fixtures.js";
import {
  DECODER,
  ENCODER,
  GOOD_CREDENTIAL,
  PROJECT_ID,
  baseSnapshot,
  decisionCount,
  depsFor,
  eventCount,
  principalFor,
  withStore,
} from "./graph-query-test-fixtures.js";

const PREVIEW_SCHEMA_VERSION = "moe-graph-preview-request/1";

interface AskOptions {
  readonly capabilities?: readonly string[];
  readonly credential?: string | null;
  readonly payload?: unknown;
  readonly queryKind?: string;
}

/**
 * A well-formed advisory request body for the landed evaluator.
 *
 * The `trimmed` variant drops the ADVISORY edge, which changes the structure
 * without breaking it — `dev-c` stays the terminal HARD sink the evaluator
 * requires. Moving the completion node instead produces GRAPH_INVALID, which
 * would compare two refusals rather than two analyses.
 */
function previewPayload(variant: "base" | "trimmed" = "base"): Record<string, unknown> {
  const snapshot = baseSnapshot();
  return {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    snapshot: variant === "base"
      ? snapshot
      : { ...snapshot, edges: snapshot.edges.filter((edge) => edge.kind !== "ADVISORY") },
  };
}

/**
 * Drives the REAL dispatch port. `graph` is deliberately left UNCONFIGURED:
 * preview is zero-authority and must not need a `GraphQueryPort`, so wiring one
 * in would hide a dependency on it.
 */
function askPreview(store: SqliteEventStore, options: AskOptions = {}): Record<string, unknown> {
  const principal: AuthenticatedPrincipal = principalFor(
    PROJECT_ID,
    options.capabilities ?? ["planning.write"],
  );
  const dispatch = createMcpDispatchPort({
    deps: depsFor(store, principal),
    subscriptions: streamPort(),
  });
  const envelope = ENCODER.encode(JSON.stringify({
    payload: options.payload ?? previewPayload(),
    queryKind: options.queryKind ?? "graph.preview",
  }));
  const credential = options.credential === undefined ? GOOD_CREDENTIAL : options.credential;
  const bridge = dispatch as unknown as HttpDispatchPort;
  const answered = credential === null
    ? (bridge.dispatchQueryBytes as (bytes: Uint8Array) => Uint8Array)(envelope)
    : bridge.dispatchQueryBytes(envelope, { credential });
  if (answered instanceof Promise) throw new Error("the query dispatch answered asynchronously");
  return JSON.parse(DECODER.decode(answered)) as Record<string, unknown>;
}

/** The production evaluator's own answer for the same body, for comparison. */
function evaluatedLocally(payload: unknown): Record<string, unknown> {
  return evaluateGraphPreviewRequestBytes(
    ENCODER.encode(JSON.stringify(payload)),
  ) as unknown as Record<string, unknown>;
}

describe("graph.preview over the shared authenticated query path", () => {
  it("answers a valid request with the evaluator's own advisory envelope", () => {
    withStore("preview", (store) => {
      const payload = previewPayload();
      const answered = askPreview(store, { payload });

      const expected = evaluatedLocally(payload);
      expect(expected["ok"], JSON.stringify(expected)).toBe(true);
      expect(answered["ok"], JSON.stringify(answered)).toBe(true);
      expect(answered["outcome"]).toBe("REQUEST_EVALUATED");
      // The advisory framing must survive the transport: an answer that lost
      // these has been re-dressed as an authoritative one somewhere.
      expect(answered["advisoryOnly"]).toBe(true);
      expect(answered["authority"]).toBe("NONE");
      // Compared against the evaluator's own output, not transcribed values.
      expect(answered["preview"]).toEqual(expected["preview"]);
    });
  });

  it("returns two DISTINCT identities for two distinct snapshots", () => {
    withStore("preview", (store) => {
      const first = previewPayload("base");
      const second = previewPayload("trimmed");
      // The fixtures must actually differ, or the distinctness below is free.
      expect(first).not.toEqual(second);

      const one = askPreview(store, { payload: first })["preview"] as Record<string, unknown>;
      const two = askPreview(store, { payload: second })["preview"] as Record<string, unknown>;

      expect(one["outcome"], JSON.stringify(one)).toBe("ANALYZED");
      expect(two["outcome"], JSON.stringify(two)).toBe("ANALYZED");
      // Kills a constant/echo branch: a handler returning a fixed envelope, or
      // echoing the request, passes the accepted control above but not this.
      expect(one["previewIdentity"]).not.toBe(two["previewIdentity"]);
      expect(one["graphIdentity"]).not.toBe(two["graphIdentity"]);
    });
  });

  it("refuses an absent credential through the shared gate BEFORE evaluating", () => {
    withStore("preview", (store) => {
      // The payload is deliberately malformed too. If the body were read first
      // this would answer with the evaluator's REQUEST_INVALID; the auth code
      // is what proves the gate ran ahead of it.
      const answered = askPreview(store, { credential: null, payload: { nope: true } });

      expect(answered["ok"], JSON.stringify(answered)).toBe(false);
      expect(answered["stage"]).toBe("AUTHENTICATE");
      expect(answered["outcome"]).toBe("REFUSED");
      expect((answered["error"] as Record<string, unknown> | undefined)?.["code"])
        .toBe("AUTHENTICATION_FAILED");
      // THE DISCRIMINATOR. A body-first path would have answered with the
      // evaluator's own REQUEST_INVALID for this deliberately malformed body,
      // so its absence is what proves the gate ran first.
      expect(answered["outcome"]).not.toBe("REQUEST_INVALID");
      expect(answered["preview"]).toBeUndefined();
    });
  });

  it("refuses a principal without the planning capability, with its exact code and layer", () => {
    withStore("preview", (store) => {
      const answered = askPreview(store, { capabilities: ["evidence.read"] });

      expect(answered["ok"], JSON.stringify(answered)).toBe(false);
      expect(answered["code"]).toBe("GRAPH_QUERY_CAPABILITY_DENIED");
      expect(answered["layer"]).toBe("GRAPH_QUERY");
      expect(answered["preview"]).toBeUndefined();
    });
  });

  it("passes a malformed body's refusal through as the EVALUATOR's, unrestamped", () => {
    withStore("preview", (store) => {
      const payload = { schemaVersion: "moe-graph-preview-request/999" };
      const answered = askPreview(store, { payload });

      const expected = evaluatedLocally(payload);
      expect(expected["ok"], JSON.stringify(expected)).toBe(false);
      expect(answered["ok"], JSON.stringify(answered)).toBe(false);
      // WHICH LAYER ANSWERED. The evaluator's envelope, not the gate's code —
      // a restamp into GRAPH_QUERY_REQUEST_INVALID would erase the distinction
      // between "the caller is not allowed" and "the body is not a request".
      expect(answered["outcome"]).toBe(expected["outcome"]);
      expect(answered["error"]).toEqual(expected["error"]);
      expect(answered["advisoryOnly"]).toBe(true);
      expect(answered["authority"]).toBe("NONE");
      expect(answered["layer"]).toBeUndefined();
      expect(answered["code"]).toBeUndefined();
    });
  });

  it("serves preview with NO GraphQueryPort and reads nothing durable", () => {
    withStore("preview", (store) => {
      const eventsBefore = eventCount(store);
      const decisionsBefore = decisionCount(store);

      const answered = askPreview(store);

      expect(answered["ok"], JSON.stringify(answered)).toBe(true);
      // Zero authority is a property of the path, not a promise in a comment:
      // the port above is built without `graph` at all, and nothing moved.
      expect(eventCount(store)).toBe(eventsBefore);
      expect(decisionCount(store)).toBe(decisionsBefore);
    });
  });

  it("advertises the kind it serves", () => {
    // DRILL-DRIVEN. Removing "graph.preview" from the roster reddened NOTHING:
    // mcp-tool-allowlist.test.ts iterates MCP_SERVED_QUERY_KINDS itself, so
    // deleting an entry only shrinks its own iteration. That covers
    // "advertised => served" and leaves the opposite direction — the one that
    // matters here — unguarded, so a kind this port answers could vanish from
    // the advertised surface and every suite would stay green.
    //
    // This is not a roster restating itself: the accepted-control case above
    // proves the PORT answers graph.preview, and this pins that the same kind
    // reaches the surface agents are told about. The pair is what has teeth.
    expect(MCP_SERVED_QUERY_KINDS).toContain("graph.preview");
    expect(wiredMcpToolKinds()).toContain("graph.preview");
  });

  it("leaves an unserved query kind on the port's own generic refusal", () => {
    withStore("preview", (store) => {
      const answered = askPreview(store, { queryKind: "graph.nonexistent" });

      expect(answered["ok"], JSON.stringify(answered)).toBe(false);
      expect((answered["error"] as Record<string, unknown> | undefined)?.["code"])
        .toBe("INPUT_INVALID");
    });
  });
});
