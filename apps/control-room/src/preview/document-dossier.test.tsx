import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentDossier } from "./document-dossier.js";
import { PREVIEW_DOCUMENT_DOSSIER_STATE } from "./document-preview-data.js";
import type { DocumentDossierState } from "./document-preview-data.js";

afterEach(cleanup);

const LOADING: DocumentDossierState = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  status: "LOADING",
});

const ERROR: DocumentDossierState = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "DOCUMENT_PROPOSALS_UNAVAILABLE",
  layer: "DOCUMENT_QUERY",
  status: "ERROR",
});

const READY: DocumentDossierState = Object.freeze({
  admissionLabel: "Admission not requested",
  advisoryOnly: true,
  authority: "NONE",
  boundaryText: "Supplied proposals remain advisory; no task records were created.",
  candidateSummaryLabel: "2 supplied work candidates · not submitted",
  candidates: Object.freeze([
    Object.freeze({
      id: "verify-retry",
      role: "Verification",
      sourceIds: Object.freeze(["acceptance", "brief"]),
      title: "Prove retry recovery",
      truthClass: "DAEMON_VERIFIED",
    }),
    Object.freeze({
      id: "write-contract",
      sourceIds: Object.freeze(["brief"]),
      title: "Write the retry contract",
      truthClass: "AGENT_REPORTED",
    }),
  ]),
  decompositionTruthClass: "AGENT_REPORTED",
  heading: "Retry recovery dossier",
  originLabel: "Document intake · supplied result",
  planQualityTruthClass: "UNKNOWN",
  provenanceNote: "Supplied document proposal; no admission or task receipt exists.",
  revisionLabel: "project/docs@9ac1",
  sources: Object.freeze([
    Object.freeze({
      excerpt: "The retry succeeds without duplicating the accepted effect.",
      id: "acceptance",
      label: "Recovery acceptance",
      path: "docs/acceptance/retry.md",
    }),
    Object.freeze({
      id: "brief",
      label: "Incident brief",
      path: "docs/incidents/retry.md",
    }),
  ]),
  status: "READY",
});

describe("DocumentDossier supplied presentation", () => {
  it("renders READY sources and candidates in supplied order with their supplied lineage", async () => {
    const user = userEvent.setup();
    render(<DocumentDossier state={READY} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent)
      .toBe("Retry recovery dossier");
    expect(screen.getByText("Document intake · supplied result")).toBeDefined();
    expect(screen.getByText("project/docs@9ac1")).toBeDefined();
    expect(screen.getByText("2 supplied work candidates · not submitted")).toBeDefined();

    const candidates = screen.getAllByTestId(/^cr\.preview\.decomposition\.task\./u);
    expect(candidates.map((candidate) => within(candidate).getByRole("heading").textContent))
      .toEqual(["Prove retry recovery", "Write the retry contract"]);
    expect(within(candidates[0]!).getAllByRole("link").map((link) => link.textContent))
      .toEqual(["Recovery acceptance", "Incident brief"]);
    expect(within(candidates[0]!).getByText("Verification")).toBeDefined();
    expect(within(candidates[1]!).queryByText("Role")).toBeNull();

    const sources = screen.getAllByTestId(/^cr\.preview\.dossier\.source\./u);
    expect(sources.map((source) => source.getAttribute("data-testid"))).toEqual([
      "cr.preview.dossier.source.acceptance",
      "cr.preview.dossier.source.brief",
    ]);
    expect(within(sources[0]!).getByText(
      "The retry succeeds without duplicating the accepted effect.",
    )).toBeDefined();
    expect(sources[1]!.textContent).not.toContain("undefined");

    await user.click(within(candidates[0]!).getByRole("link", { name: "Incident brief" }));
    expect((sources[1]!.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("renders LOADING without stale fixture, source, candidate, or action content", () => {
    const { container } = render(<DocumentDossier state={LOADING} />);

    expect(screen.getByRole("status").textContent).toContain("Reading project documents");
    expect(screen.queryByText("Stale-port recovery dossier")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.preview.decomposition.task.']")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.preview.dossier.source.']")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.action.']")).toBeNull();
  });

  it("renders the exact ERROR code and layer without stale proposal content", () => {
    const { container } = render(<DocumentDossier state={ERROR} />);
    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("DOCUMENT_PROPOSALS_UNAVAILABLE");
    expect(alert.textContent).toContain("DOCUMENT_QUERY");
    expect(screen.queryByText("Stale-port recovery dossier")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.preview.decomposition.task.']")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.preview.dossier.source.']")).toBeNull();
    expect(container.querySelector("[data-testid^='cr.action.']")).toBeNull();
  });

  it.each([
    ["LOADING", LOADING],
    ["READY", READY],
    ["ERROR", ERROR],
  ] as const)("marks %s as advisory and zero-authority at the top level", (status, state) => {
    render(<DocumentDossier state={state} />);
    const dossier = screen.getByTestId("cr.preview.dossier");

    expect(dossier.getAttribute("data-state")).toBe(status);
    expect(dossier.getAttribute("data-authority")).toBe("none");
    expect(dossier.getAttribute("data-advisory-only")).toBe("true");
    expect(dossier.querySelector("[data-testid^='cr.action.']")).toBeNull();
  });

  it("exports the current preview as a deeply frozen READY fixture", () => {
    expect(PREVIEW_DOCUMENT_DOSSIER_STATE.status).toBe("READY");
    expect(PREVIEW_DOCUMENT_DOSSIER_STATE.boundaryText)
      .toBe("No daemon attached; no task records were created.");
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE)).toBe(true);
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE.sources)).toBe(true);
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE.sources[0])).toBe(true);
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE.candidates)).toBe(true);
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE.candidates[0])).toBe(true);
    expect(Object.isFrozen(PREVIEW_DOCUMENT_DOSSIER_STATE.candidates[0]?.sourceIds)).toBe(true);
  });
});
