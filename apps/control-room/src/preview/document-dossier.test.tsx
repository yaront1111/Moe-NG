import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentDossier } from "./document-dossier.js";
import {
  CONTENT_HASH,
  CONTEXT_HASH,
  REPOSITORY_HASH,
  dossierProposal,
  readyState,
} from "./document-dossier-test-data.js";
import { documentDossierStateFromProposal } from "./document-dossier-state.js";
import type { DocumentDossierState } from "./document-dossier-state.js";

afterEach(cleanup);

describe("DocumentDossier proposal presentation", () => {
  it("renders public proposal facts without invented workflow or caller-authored labels", () => {
    expect(() => { render(<DocumentDossier state={readyState()} />); }).not.toThrow();

    expect(screen.getByText("retry-recovery")).toBeDefined();
    expect(screen.getByText(
      "Prove retry recovery without duplicating the accepted effect.",
    )).toBeDefined();
    expect(screen.queryByText("Role")).toBeNull();
    expect(screen.queryByText("Owner")).toBeNull();
    expect(screen.queryByText("Progress")).toBeNull();
  });

  it("shows exact proposal identity, source evidence, objectives, and closed status copy", () => {
    render(<DocumentDossier state={readyState()} />);
    const dossier = screen.getByTestId("cr.preview.dossier");

    expect(within(dossier).getByText("Document intake · daemon proposal")).toBeDefined();
    expect(within(dossier).getByText("1 document-derived candidate · not submitted"))
      .toBeDefined();
    expect(within(dossier).getByText("NOT_SUBMITTED · advisory only · authority NONE"))
      .toBeDefined();
    expect(within(dossier).getByText(
      "Daemon proposal remains advisory; no task records were created.",
    )).toBeDefined();

    for (const [testId, value] of [
      ["cr.preview.dossier.meta.project", "retry-recovery"],
      ["cr.preview.dossier.meta.schema", "moe-document-work-proposal/1"],
      ["cr.preview.dossier.meta.repository", REPOSITORY_HASH],
      ["cr.preview.dossier.meta.context", CONTEXT_HASH],
    ] as const) {
      expect(within(dossier).getByTestId(testId).textContent).toContain(value);
    }

    const candidate = within(dossier).getByTestId("cr.preview.decomposition.task.0");
    const objective = within(candidate).getByText(
      "Prove retry recovery without duplicating the accepted effect.",
    );
    expect(objective.classList.contains("cr-dossier-token")).toBe(true);
    const bindings = within(candidate)
      .getAllByTestId(/^cr\.preview\.decomposition\.source\./u);
    expect(bindings.map((binding) => binding.textContent)).toEqual([
      "docs/acceptance/retry.mdsource-acceptance",
      "docs/incidents/retry.mdsource-brief",
    ]);

    const source = within(dossier).getByTestId("cr.preview.dossier.source.0");
    expect(within(source).getByText(CONTENT_HASH).classList.contains("cr-dossier-token"))
      .toBe(true);
    expect(within(source).getByText("412 bytes")).toBeDefined();
  });

  it("renders invalid proposal relationships as the exact presentation-layer error", () => {
    const input = dossierProposal();
    const invalid = documentDossierStateFromProposal({
      dossierIdentity: "invalid",
      origin: "DAEMON",
      proposal: {
        ...input,
        candidates: [{ ...input.candidates[0]!, sourceRefs: ["source-missing"] }],
      },
    });
    const { container } = render(<DocumentDossier state={invalid} />);

    expect(screen.getByRole("alert").textContent)
      .toContain("DOCUMENT_DOSSIER_STATE_INVALID");
    expect(screen.getByRole("alert").textContent).toContain("CONTROL_ROOM_PRESENTATION");
    expect(container.querySelector("[data-testid^='cr.preview.decomposition.task.']"))
      .toBeNull();
  });

  const LOADING: DocumentDossierState = Object.freeze({
    advisoryOnly: true, authority: "NONE", status: "LOADING",
  });
  const ERROR: DocumentDossierState = Object.freeze({
    advisoryOnly: true, authority: "NONE", code: "DOCUMENT_PROPOSALS_UNAVAILABLE",
    layer: "DOCUMENT_QUERY", status: "ERROR",
  });

  it.each([
    ["LOADING", LOADING], ["READY", readyState()], ["ERROR", ERROR],
  ] as const)("keeps %s advisory-only, zero-authority, and action-free", (status, state) => {
    render(<DocumentDossier state={state} />);
    const dossier = screen.getByTestId("cr.preview.dossier");
    expect(dossier.getAttribute("data-state")).toBe(status);
    expect(dossier.getAttribute("data-advisory-only")).toBe("true");
    expect(dossier.getAttribute("data-authority")).toBe("none");
    expect(dossier.querySelector("[data-testid^='cr.action.']")).toBeNull();
  });

  it("keeps loading and exact transport errors free of stale proposal content", () => {
    const { rerender } = render(<DocumentDossier state={LOADING} />);
    expect(screen.getByRole("status").textContent).toContain("Reading project documents");
    expect(screen.queryByText("retry-recovery")).toBeNull();

    rerender(<DocumentDossier state={ERROR} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("DOCUMENT_PROPOSALS_UNAVAILABLE");
    expect(alert.textContent).toContain("DOCUMENT_QUERY");
    expect(screen.queryByText("retry-recovery")).toBeNull();
  });
});
