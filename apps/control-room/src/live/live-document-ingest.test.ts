import { describe, expect, it } from "vitest";

import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../preview/document-preview-data.js";
import { ingestDocument, mapIngestAnswer } from "./live-document-ingest.js";
import type { DocumentIngestRequest } from "./live-document-ingest.js";

/**
 * The operator PRD-ingest client (UI-4). The proposal fixture is decoded through
 * the SAME public @moe/contracts seam production crosses - never hand-rolled wire
 * bytes - so the test cannot pass on a shape the real decoder would refuse.
 * PREVIEW_DOCUMENT_WORK_PROPOSAL's candidates sort by candidateRef, so the first
 * candidate the client reads is "recovery-contract" -> "Write the recovery contract".
 */

const FIRST_CANDIDATE_TITLE = "Write the recovery contract";

const INGESTED = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  byteLength: 42,
  contentSha256: "a".repeat(64),
  disposition: "DECIDED",
  ok: true,
  outcome: "INGESTED",
  proposal: PREVIEW_DOCUMENT_WORK_PROPOSAL,
  proposalAggregateId: "document-work/x",
  proposalEventId: "document-work-proposal/x",
  sourceAggregateId: "document-source/x",
  sourceDisposition: "DECIDED",
  sourceEventId: "document-source-event/x",
});

function response(status: number, body: unknown): Response {
  return { json: async () => body, status } as unknown as Response;
}

describe("mapIngestAnswer shapes the ingest route's answer", () => {
  it("maps an exact INGESTED frame, reading the first candidate title", () => {
    const outcome = mapIngestAnswer(200, INGESTED);
    expect(outcome).toStrictEqual({
      byteLength: 42,
      candidateTitle: FIRST_CANDIDATE_TITLE,
      contentSha256: "a".repeat(64),
      status: "INGESTED",
    });
  });

  it("carries a listener refusal out at its own layer", () => {
    expect(mapIngestAnswer(400, {
      code: "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID",
      layer: "CONTROL_ROOM_LISTENER",
    })).toStrictEqual({
      code: "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID",
      layer: "CONTROL_ROOM_LISTENER",
      status: "REFUSED",
    });
  });

  it("carries a service refusal (six-key frame) out at its own layer", () => {
    expect(mapIngestAnswer(200, {
      advisoryOnly: true,
      authority: "NONE",
      code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID",
      layer: "DAEMON_INGRESS",
      ok: false,
      outcome: "REFUSED",
    })).toStrictEqual({
      code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID",
      layer: "DAEMON_INGRESS",
      status: "REFUSED",
    });
  });

  it("carries the route's own three-key refusal (capability/project) at its own layer", () => {
    // The exact frame document-ingest-route.ts replies for an operator lacking
    // ADMIN or a project mismatch: a 200 { code, layer, outcome:"REFUSED" }.
    expect(mapIngestAnswer(200, {
      code: "DOCUMENT_INGEST_CAPABILITY_DENIED",
      layer: "DOCUMENT_INGEST_ROUTE",
      outcome: "REFUSED",
    })).toStrictEqual({
      code: "DOCUMENT_INGEST_CAPABILITY_DENIED",
      layer: "DOCUMENT_INGEST_ROUTE",
      status: "REFUSED",
    });
  });

  it("carries an adapter auth refusal ({error,stage}) out at its stage layer", () => {
    expect(mapIngestAnswer(401, {
      error: { code: "AUTHENTICATION_FAILED" },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    })).toStrictEqual({
      code: "AUTHENTICATION_FAILED",
      layer: "AUTHENTICATE",
      status: "REFUSED",
    });
  });

  it("carries the authenticator's PORT_REFUSED frame out at its stage layer", () => {
    expect(mapIngestAnswer(401, {
      httpStatus: 401,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "SESSION_CREDENTIAL_REVOKED" },
      stage: "AUTHENTICATE",
    })).toStrictEqual({
      code: "SESSION_CREDENTIAL_REVOKED",
      layer: "AUTHENTICATE",
      status: "REFUSED",
    });
  });

  it("errors on a non-200 answer that is not a refusal", () => {
    expect(mapIngestAnswer(500, { ok: true })).toStrictEqual({
      code: "DOCUMENT_INGEST_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_DOCUMENTS",
      status: "ERROR",
    });
  });

  it("errors on a 200 whose proposal cannot be decoded", () => {
    const outcome = mapIngestAnswer(200, { ...INGESTED, proposal: { not: "a proposal" } });
    expect(outcome.status).toBe("ERROR");
    if (outcome.status !== "ERROR") throw new Error("expected an error outcome");
    // The decoder's own code/layer are carried, not this client's generic invalid.
    expect(outcome.code).toBe("DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID");
  });

  it("errors on a 200 INGESTED frame carrying an extra field", () => {
    expect(mapIngestAnswer(200, { ...INGESTED, extra: true }).status).toBe("ERROR");
  });
});

describe("ingestDocument sends only the allow-list and maps the answer", () => {
  it("posts the request body EXACTLY - no extra key", async () => {
    let captured: string | undefined;
    const request: DocumentIngestRequest = {
      displayPath: "prd.md",
      mediaType: "text/markdown",
      text: "# PRD\nbuild it",
    };
    const outcome = await ingestDocument({}, request, (body) => {
      captured = body;
      return Promise.resolve(response(200, INGESTED));
    });

    expect(outcome.status).toBe("INGESTED");
    const parsed = JSON.parse(captured ?? "") as Record<string, unknown>;
    expect(Object.keys(parsed)).toStrictEqual(["displayPath", "mediaType", "text"]);
    expect(parsed).toStrictEqual({
      displayPath: "prd.md",
      mediaType: "text/markdown",
      text: "# PRD\nbuild it",
    });
  });

  it("maps a thrown round trip to a transport ERROR", async () => {
    const outcome = await ingestDocument(
      {},
      { displayPath: "prd.md", mediaType: "text/markdown", text: "x" },
      () => Promise.reject(new Error("boom")),
    );
    expect(outcome).toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED",
      layer: "CONTROL_ROOM_LIVE_DOCUMENTS",
      status: "ERROR",
    });
  });

  it("maps an unparseable body to an invalid-response ERROR", async () => {
    const bad = {
      json: () => Promise.reject(new Error("not json")),
      status: 200,
    } as unknown as Response;
    const outcome = await ingestDocument(
      {},
      { displayPath: "prd.md", mediaType: "text/markdown", text: "x" },
      () => Promise.resolve(bad),
    );
    expect(outcome).toStrictEqual({
      code: "DOCUMENT_INGEST_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_DOCUMENTS",
      status: "ERROR",
    });
  });
});
