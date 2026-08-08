import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TRUTH_ABSENT_PROVENANCE, TRUTH_INVALID_PROVENANCE } from "../kernel.js";
import { UNKNOWN_FACT_VALUE } from "./node-authority.js";
import type { PresentedFact } from "./node-authority.js";
import { NodeEvidence } from "./node-evidence.js";
import type { NodeEvidenceProps } from "./node-evidence.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const verified = (value: string): PresentedFact => ({ truthClass: "DAEMON_VERIFIED", value });
const observed = (value: string): PresentedFact => ({ truthClass: "OBSERVED", value });
const FULL_DIGEST = "sha256:9c1d4f7b2e6a80c35f19adbe7742c0916d38ee5a4b0f7c2d81953ae6f0b4c7d2";

function evidenceProps(): NodeEvidenceProps {
  return {
    artifacts: [
      {
        artifactId: "openapi.diff", artifactType: observed("diff"),
        digest: verified(FULL_DIGEST), provenanceRef: "receipt/rcpt-2",
      },
      {
        artifactId: "bench.json", artifactType: observed("measurement"),
        digest: verified("sha256:bench-77"), provenanceRef: "receipt/rcpt-1",
      },
    ],
    blockers: [{
      blockerId: "blk-1", detail: observed("waiting on staging credentials rotation"),
      owner: observed("human/operator-1"), state: observed("OPEN"),
    }],
    findings: [{
      category: observed("integration"), detail: observed("contract drift on POST /retry"),
      findingId: "fnd-1", severity: observed("HIGH"),
    }],
    receipts: [
      { provenanceRef: "receipt/rcpt-1", receiptId: "rcpt-1", recipe: verified("pnpm test"), result: verified("exit 0") },
      { provenanceRef: "receipt/rcpt-2", receiptId: "rcpt-2", recipe: verified("pnpm typecheck"), result: verified("exit 1") },
    ],
  };
}

const idsUnder = (container: HTMLElement, prefix: string): string[] =>
  [...container.querySelectorAll(`[data-testid^='${prefix}']`)]
    .map((node) => node.getAttribute("data-testid") ?? "");

const valueOf = (factId: string): string =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId("cr.value").textContent ?? "";

const chipOf = (factId: string): HTMLElement =>
  within(screen.getByTestId(`cr.fact.${factId}`)).getByTestId(/^cr\.chip\./u);

describe("node evidence renders supplied receipts, artifacts, findings, and blockers", () => {
  it("gives each kind its own section and each receipt the pinned inspector id", () => {
    const { container } = render(<NodeEvidence {...evidenceProps()} />);
    for (const section of ["receipts", "artifacts", "findings", "blockers"]) {
      const element = screen.getByTestId(`cr.inspector.section.${section}`);
      expect(element.tagName).toBe("SECTION");
      expect(within(element).getByRole("heading").textContent).not.toBe("");
    }
    expect(idsUnder(container, "cr.inspector.receipt."))
      .toEqual(["cr.inspector.receipt.rcpt-1", "cr.inspector.receipt.rcpt-2"]);
    expect(idsUnder(container, "cr.inspector.artifact."))
      .toEqual(["cr.inspector.artifact.openapi.diff", "cr.inspector.artifact.bench.json"]);
  });

  it("preserves the supplied order and never sorts the supplied arrays in place", () => {
    const props = evidenceProps();
    const receipts = Object.freeze([...props.receipts].reverse());
    const { container } = render(<NodeEvidence {...props} receipts={receipts} />);
    expect(idsUnder(container, "cr.inspector.receipt."))
      .toEqual(["cr.inspector.receipt.rcpt-2", "cr.inspector.receipt.rcpt-1"]);
    expect(receipts.map((receipt) => receipt.receiptId)).toEqual(["rcpt-2", "rcpt-1"]);
  });

  it("distinguishes receipt result, artifact identity and full digest, finding, and blocker", () => {
    render(<NodeEvidence {...evidenceProps()} />);
    expect(valueOf("receipt.rcpt-1.result")).toBe("exit 0");
    expect(valueOf("receipt.rcpt-2.result")).toBe("exit 1");
    expect(valueOf("receipt.rcpt-1.recipe")).toBe("pnpm test");
    expect(valueOf("artifact.openapi.diff.type")).toBe("diff");
    // Full digest, never an abbreviation: a truncated digest cannot be compared.
    expect(valueOf("artifact.openapi.diff.digest")).toBe(FULL_DIGEST);
    expect(valueOf("finding.fnd-1.category")).toBe("integration");
    expect(valueOf("finding.fnd-1.severity")).toBe("HIGH");
    expect(valueOf("finding.fnd-1.detail")).toBe("contract drift on POST /retry");
    expect(valueOf("blocker.blk-1.owner")).toBe("human/operator-1");
    expect(valueOf("blocker.blk-1.state")).toBe("OPEN");
  });

  it("encodes each supplied class as text, icon, and colour at once", () => {
    render(<NodeEvidence {...evidenceProps()} />);
    const receipt = chipOf("receipt.rcpt-1.result");
    expect(within(receipt).getByTestId("cr.glyph").textContent).toBe("▣");
    expect(within(receipt).getByTestId("cr.shortlabel").textContent).toBe("VER");
    expect(receipt.getAttribute("data-tone")).toBe("green");
    const blocker = chipOf("blocker.blk-1.state");
    expect(within(blocker).getByTestId("cr.glyph").textContent).toBe("●");
    expect(within(blocker).getByTestId("cr.shortlabel").textContent).toBe("OBS");
    expect(blocker.getAttribute("data-tone")).toBe("neutral slate");
  });

  it("says none for an empty supplied collection instead of rendering nothing", () => {
    const { container } = render(
      <NodeEvidence artifacts={[]} blockers={[]} findings={[]} receipts={[]} />,
    );
    for (const section of ["receipts", "artifacts", "findings", "blockers"]) {
      expect(screen.getByTestId(`cr.inspector.section.${section}`).textContent).toContain("none");
    }
    expect(container.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(0);
  });
});

describe("missing evidence is UNKNOWN and offers no active link", () => {
  it("renders UNKNOWN with the missing-class note and no success wording", () => {
    const props = evidenceProps();
    render(
      <NodeEvidence
        {...props}
        receipts={[{ provenanceRef: null, receiptId: "rcpt-3", recipe: null, result: null }]}
      />,
    );
    const wrapper = screen.getByTestId("cr.inspector.receipt.rcpt-3");
    expect(valueOf("receipt.rcpt-3.result")).toBe(UNKNOWN_FACT_VALUE);
    expect(valueOf("receipt.rcpt-3.recipe")).toBe(UNKNOWN_FACT_VALUE);
    expect(wrapper.textContent).not.toMatch(/pass|success|green|verified|exit 0/iu);
    const chip = chipOf("receipt.rcpt-3.result");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
    expect(chip.getAttribute("data-origin")).toBe("ABSENT");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_ABSENT_PROVENANCE);
  });

  it("links evidence only when both identity and provenance are supplied", () => {
    const props = evidenceProps();
    const { container } = render(
      <NodeEvidence
        {...props}
        artifacts={[
          { artifactId: "orphan.bin", artifactType: observed("blob"), digest: null, provenanceRef: null },
          { artifactId: "", artifactType: observed("blob"), digest: verified("sha256:x"), provenanceRef: "receipt/rcpt-1" },
        ]}
      />,
    );
    expect(idsUnder(container, "cr.evidence.link."))
      .toEqual(["cr.evidence.link.receipt.rcpt-1", "cr.evidence.link.receipt.rcpt-2"]);
    expect(valueOf("artifact.orphan.bin.digest")).toBe(UNKNOWN_FACT_VALUE);
    const anonymous = screen.getByTestId("cr.inspector.artifact.UNKNOWN");
    expect(within(anonymous).queryByRole("link")).toBeNull();
  });

  it("reports TRUTH_CLASS_INVALID for a malformed supplied class", () => {
    const props = evidenceProps();
    render(
      <NodeEvidence
        {...props}
        findings={[{
          category: { truthClass: { code: "OBSERVED" }, value: "integration" },
          detail: observed("contract drift"), findingId: "fnd-9", severity: observed("HIGH"),
        }]}
      />,
    );
    const chip = chipOf("finding.fnd-9.category");
    expect(chip.getAttribute("data-origin")).toBe("INVALID");
    expect(chip.getAttribute("data-provenance-note")).toBe(TRUTH_INVALID_PROVENANCE);
    expect(TRUTH_INVALID_PROVENANCE).toContain("TRUTH_CLASS_INVALID");
    expect(chip.getAttribute("data-truth-class")).toBe("UNKNOWN");
  });

  it("exposes no rerun, edit, or mutation affordance over evidence", () => {
    const { container } = render(<NodeEvidence {...evidenceProps()} />);
    expect(container.querySelectorAll("button").length)
      .toBe(container.querySelectorAll("[data-testid^='cr.chip.']").length);
    expect(container.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
    expect(container.querySelectorAll("input, textarea, form").length).toBe(0);
  });
});
