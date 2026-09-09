/**
 * The document intake dossier on the v2 PRD panel.
 *
 * REAL FRAME, PRODUCTION DECODER. The daemon's DOSSIER envelope carries the same proposal the
 * preview data module holds, and it reaches the screen only through mapDocumentDossierAnswer -
 * the EXISTING decoder, which runs the published decodeDocumentWorkProposalBytes codec over
 * the response. Nothing is typed straight into the component, so a proposal shape drift is
 * refused by the codec and reddens these arms rather than rendering an invented dossier.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { mapDocumentDossierAnswer } from "../../live/live-document-dossier.js";
import { PREVIEW_DOCUMENT_WORK_PROPOSAL } from "../../preview/document-preview-data.js";
import type { DocumentDossierState } from "../../preview/document-dossier-state.js";
import { LivePrd } from "./prd-panel.js";
import { LivePrdDossier, PrdDossier, createDocumentDossierTransport } from "./prd-dossier.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const DOSSIER_FRAME = Object.freeze({
  advisoryOnly: true,
  aggregateId: "document-work/prd",
  aggregateSequence: 3,
  authority: "NONE",
  committedAt: "2026-09-05T09:00:00.000Z",
  eventId: "document-work-proposal/prd",
  ok: true,
  outcome: "DOSSIER",
  proposal: PREVIEW_DOCUMENT_WORK_PROPOSAL,
});

function readyState(): DocumentDossierState {
  const state = mapDocumentDossierAnswer({
    delivered: true, response: DOSSIER_FRAME, status: 200,
  });
  if (state.status !== "READY") {
    const why = state.status === "ERROR" ? `${state.code} @ ${state.layer}` : state.status;
    throw new Error(`the production dossier decoder refused the real frame: ${why}`);
  }
  return state;
}

describe("PrdDossier", () => {
  it("renders the decoded proposal: every source binding and every candidate", () => {
    render(<PrdDossier state={readyState()} />);
    expect(PREVIEW_DOCUMENT_WORK_PROPOSAL.sources.length).toBeGreaterThan(0);
    expect(PREVIEW_DOCUMENT_WORK_PROPOSAL.candidates.length).toBeGreaterThan(0);
    for (const binding of PREVIEW_DOCUMENT_WORK_PROPOSAL.sources) {
      const row = screen.getByTestId(`cr.prd.dossier.source.${binding.sourceRef}`);
      expect(row.textContent).toContain(binding.displayPath);
      expect(row.textContent).toContain(binding.contentSha256);
    }
    for (const candidate of PREVIEW_DOCUMENT_WORK_PROPOSAL.candidates) {
      const row = screen.getByTestId(`cr.prd.dossier.candidate.${candidate.candidateRef}`);
      expect(row.textContent).toContain(candidate.title);
      expect(row.textContent).toContain(candidate.objective);
    }
    expect(screen.getByTestId("cr.prd.dossier.manifest").textContent)
      .toContain(PREVIEW_DOCUMENT_WORK_PROPOSAL.contextManifestDigest);
  });

  it("says it is reading rather than showing an empty dossier", () => {
    render(<PrdDossier state={{ advisoryOnly: true, authority: "NONE", status: "LOADING" }} />);
    expect(screen.getByTestId("cr.prd.dossier.loading")).toBeTruthy();
    expect(screen.queryByTestId("cr.prd.dossier.body")).toBeNull();
  });
});

describe("LivePrdDossier", () => {
  it("drives the EXISTING feed and renders what it decodes", async () => {
    render(
      <LivePrdDossier
        headers={{}}
        intervalMs={60_000}
        transport={{
          readDocumentDossier: async () => ({
            delivered: true, response: DOSSIER_FRAME, status: 200,
          }),
        }}
      />,
    );
    const first = PREVIEW_DOCUMENT_WORK_PROPOSAL.sources[0];
    if (first === undefined) throw new Error("the preview proposal binds no source");
    await waitFor(() => {
      expect(screen.getByTestId(`cr.prd.dossier.source.${first.sourceRef}`)).toBeTruthy();
    });
  });

  it("renders a daemon refusal VERBATIM instead of an empty dossier", async () => {
    render(
      <LivePrdDossier
        headers={{}}
        intervalMs={60_000}
        transport={{
          readDocumentDossier: async () => ({
            delivered: true,
            response: {
              advisoryOnly: true, authority: "NONE", code: "DOCUMENT_WORK_DOSSIER_MISSING",
              layer: "DAEMON_READ_MODEL", ok: false, outcome: "REFUSED",
            },
            status: 200,
          }),
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cr.prd.dossier.refusal").textContent)
        .toContain("DOCUMENT_WORK_DOSSIER_MISSING @ DAEMON_READ_MODEL");
    });
    expect(screen.queryByTestId("cr.prd.dossier.body")).toBeNull();
  });
});

describe("createDocumentDossierTransport", () => {
  it("POSTs the route's exact empty body and carries the answer through", async () => {
    let sent: string | null = null;
    const transport = createDocumentDossierTransport({ "x-moe-csrf": "t" }, async (body) => {
      sent = body;
      return new Response(JSON.stringify(DOSSIER_FRAME), { status: 200 });
    });
    const result = await transport.readDocumentDossier();
    expect(sent).toBe("{}");
    expect(JSON.parse(sent ?? "null")).toEqual({});
    expect(result).toMatchObject({ delivered: true, status: 200 });
  });

  it("names the transport when nothing was delivered", async () => {
    const transport = createDocumentDossierTransport({}, async () => {
      throw new Error("offline");
    });
    expect(await transport.readDocumentDossier()).toEqual({
      code: "TRANSPORT_REQUEST_FAILED",
      delivered: false,
      layer: "CONTROL_ROOM_TRANSPORT",
    });
  });

  it("names an unreadable body rather than inventing an answer", async () => {
    const transport = createDocumentDossierTransport({}, async () =>
      new Response("not json", { status: 200 }));
    expect(await transport.readDocumentDossier()).toEqual({
      code: "TRANSPORT_RESPONSE_UNREADABLE",
      delivered: false,
      layer: "CONTROL_ROOM_TRANSPORT",
    });
  });
});

/**
 * THE TWO READS ON THE PRD PANEL ARE INDEPENDENT.
 *
 * /goals/source/read and /documents/dossier/read answer different questions from different
 * durable facts. Either can refuse. Neither refusal may blank the other's answer, and neither
 * may be rendered as emptiness: a missing dossier says so in words carrying its code.
 */
describe("the PRD panel keeps its two reads independent", () => {
  const SOURCE = {
    byteLength: 42, contentSha256: "a".repeat(64), displayPath: "docs/PRD.md",
    mediaType: "text/markdown", sourceRef: "prd", status: "GOAL_SOURCE" as const,
    text: "# UnAI\n\n## 1. Goal\n\nThe product.\n",
  };

  it("shows the stored PRD text while the dossier read refuses", async () => {
    render(
      <LivePrd
        dossierTransport={{
          readDocumentDossier: async () => ({
            delivered: true,
            response: {
              advisoryOnly: true, authority: "NONE", code: "DOCUMENT_WORK_DOSSIER_MISSING",
              layer: "DAEMON_READ_MODEL", ok: false, outcome: "REFUSED",
            },
            status: 200,
          }),
        }}
        goalRef="goal-1"
        headers={{}}
        read={async () => SOURCE}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cr.prd.dossier.refusal").textContent)
        .toContain("DOCUMENT_WORK_DOSSIER_MISSING @ DAEMON_READ_MODEL");
    });
    expect(screen.getByTestId("cr.prd.text").textContent).toBe(SOURCE.text);
    expect(screen.queryByTestId("cr.prd.dossier.body")).toBeNull();
  });

  it("shows the dossier while the PRD source read refuses", async () => {
    render(
      <LivePrd
        dossierTransport={{
          readDocumentDossier: async () => ({
            delivered: true, response: DOSSIER_FRAME, status: 200,
          }),
        }}
        goalRef="goal-1"
        headers={{}}
        read={async () => ({
          code: "GOAL_SOURCE_UNBOUND", layer: "DAEMON_READ_MODEL", status: "REFUSED" as const,
        })}
      />,
    );
    const first = PREVIEW_DOCUMENT_WORK_PROPOSAL.sources[0];
    if (first === undefined) throw new Error("the preview proposal binds no source");
    await waitFor(() => {
      expect(screen.getByTestId(`cr.prd.dossier.source.${first.sourceRef}`)).toBeTruthy();
    });
    expect(screen.getByTestId("cr.prd.unbound").textContent)
      .toBe("This goal was created without a PRD.");
  });
});
