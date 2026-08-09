import type { DocumentWorkProposal } from "@moe/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentDossier } from "./document-dossier.js";
import { dossierProposal, readyState } from "./document-dossier-test-data.js";

afterEach(cleanup);

describe("DocumentDossier interaction identity", () => {
  it("resets open source and provenance state for a new proposal object with the same identity", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DocumentDossier state={readyState()} />);
    const sourceLink = screen.queryByTestId("cr.preview.decomposition.source.0.1");
    expect(sourceLink).not.toBeNull();
    if (sourceLink === null) return;
    await user.click(sourceLink);
    const truthButton = screen.queryByRole("button", {
      name: /Provenance for Prove retry recovery/u,
    });
    expect(truthButton).not.toBeNull();
    if (truthButton === null) return;
    await user.click(truthButton);
    expect(screen.getByTestId("cr.preview.dossier.provenance")).toBeDefined();
    expect((screen.getByTestId("cr.preview.dossier.source.1")
      .querySelector("details") as HTMLDetailsElement).open).toBe(true);

    const replacement = dossierProposal({
      candidates: [{
        ...dossierProposal().candidates[0]!,
        objective: "Replacement proposal content.",
      }],
    });
    rerender(<DocumentDossier state={readyState({ proposal: replacement })} />);

    expect(screen.queryByTestId("cr.preview.dossier.provenance")).toBeNull();
    expect((screen.getByTestId("cr.preview.dossier.source.1")
      .querySelector("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("uses unique useId-derived targets and index ARIA bindings for two instances", () => {
    const hostileRef = `source\"><script>alert("binding")</script>#fragment`;
    const input = dossierProposal();
    const hostile = dossierProposal({
      candidates: [{ ...input.candidates[0]!, sourceRefs: [hostileRef] }],
      sources: [{ ...input.sources[0]!, sourceRef: hostileRef }],
    });
    const { container } = render(<>
      <DocumentDossier state={readyState({ proposal: hostile })} />
      <DocumentDossier state={readyState({ proposal: hostile })} />
    </>);

    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes(hostileRef))).toBe(false);
    const dossiers = screen.getAllByTestId("cr.preview.dossier");
    for (const dossier of dossiers) {
      const link = within(dossier).getByTestId("cr.preview.decomposition.source.0.0");
      const controls = link.getAttribute("aria-controls");
      expect(controls).toMatch(/^cr-dossier-[a-zA-Z0-9_-]+-source-0$/u);
      expect(link.getAttribute("href")).toBe(`#${controls}`);
      const target = controls === null ? null : document.getElementById(controls);
      expect(target).not.toBeNull();
      expect(target === null ? false : dossier.contains(target)).toBe(true);
    }
  });

  it.each([
    ["INVALID", "MALFORMED", "TRUTH_CLASS_INVALID: class present but not a daemon-supplied supported value"],
    ["ABSENT", undefined, "class missing from payload"],
  ] as const)("renders %s truth origin and exact provenance note", async (
    expectedOrigin, truthClass, expectedNote,
  ) => {
    const user = userEvent.setup();
    const malformed = {
      ...dossierProposal(),
      truthClass,
    } as unknown as DocumentWorkProposal;
    render(<DocumentDossier state={readyState({ proposal: malformed })} />);
    const button = screen.queryByRole("button", { name: /Provenance for Prove retry recovery/u });
    expect(button).not.toBeNull();
    if (button === null) return;
    await user.click(button);
    const provenance = screen.getByTestId("cr.preview.dossier.provenance");
    expect(within(provenance).getByTestId("cr.preview.dossier.truth-origin").textContent)
      .toBe(expectedOrigin);
    expect(within(provenance).getByTestId("cr.preview.dossier.truth-note").textContent)
      .toBe(expectedNote);
  });
});
