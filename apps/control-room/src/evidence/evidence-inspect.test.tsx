import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { UNSTATED } from "../data/data-contract.js";
import { UNKNOWN_FACT_VALUE } from "../nodes/node-authority.js";
import type { TimelineCursorState, TimelineProvenance } from "../timeline/timeline-contract.js";
import type { EvidenceReceiptRecord } from "./evidence-contract.js";
import { EvidenceInspect } from "./evidence-inspect.js";
import type { EvidenceInspectProps } from "./evidence-inspect.js";

/**
 * Evidence INSPECTION. Altering or upgrading evidence is out of scope, so this surface
 * renders no rerun and no mutate affordance and synthesizes none: an action may appear
 * only because the daemon stated it, and the daemon states none here.
 *
 * Every value is printed as supplied. A digest is never elided, because a truncated
 * digest cannot be compared and a fact that cannot be compared is not evidence.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const OUTPUT_DIGEST =
  "sha256:9c1d4f7b2e6a80c35f19adbe7742c0916d38ee5a4b0f7c2d81953ae6f0b4c7d2";
const OPENAPI_DIGEST =
  "sha256:41c6b2ad8e5039fb7c1d0a94e6238b5f70ac9d13e8f24506bb7391cd0e5a8f77";
const BASE_SHA = "a3f9c2d1e40b78659c2af013d6b8e5471c09fa32";
const HEAD_SHA = "7b1e08d4a95cf3620e8d17ba4c96f2308de5b174";
const DIRTY_DIGEST =
  "sha256:0d5e83ba14c97f26e0b3a7d918456cf203e7b6819da4f0c5731e28ab96d40f6e";

function provenanceOf(over: Partial<TimelineProvenance> = {}): TimelineProvenance {
  return {
    actor: "daemon/runner",
    aggregateId: "api-endpnt",
    commandId: "cmd-4819",
    effectId: "eff-4819",
    eventId: "evt-4819",
    leaseEpoch: 7,
    sessionId: "session-w-3",
    timestamp: "2026-08-09T09:41:02.000Z",
    typedLink: { kind: "receipt", label: "Runner receipt", ref: "receipt/rcpt-4819" },
    ...over,
  };
}

function receiptOf(over: Partial<EvidenceReceiptRecord> = {}): EvidenceReceiptRecord {
  return {
    artifacts: [
      { artifactId: "openapi.diff", digest: OPENAPI_DIGEST },
      { artifactId: "bench.json", digest: null },
    ],
    output: { digest: OUTPUT_DIGEST, tail: "4 passed, 0 failed" },
    provenance: provenanceOf(),
    receiptId: "rcpt-4819",
    recipe: {
      argv: ["pnpm", "--filter", "@moe/api", "test:contract"],
      cwd: "D:/projexts/moe-next",
      envFingerprint: "env:node22.14.0/pnpm10.4.1",
    },
    run: { endedAt: "2026-08-09T09:41:02.000Z", exitCode: 0, startedAt: "2026-08-09T09:40:21.000Z" },
    tree: { baseSha: BASE_SHA, dirtyTreeDigest: DIRTY_DIGEST, headSha: HEAD_SHA },
    truthClass: "DAEMON_VERIFIED",
    ...over,
  };
}

const CURSOR: TimelineCursorState = { appliedSequence: 4819, latestSequence: 4819, live: true };

function inspectProps(over: Partial<EvidenceInspectProps> = {}): EvidenceInspectProps {
  return {
    comparison: null,
    cursorState: CURSOR,
    receipt: receiptOf(),
    rejection: null,
    sessionMessages: [],
    ...over,
  };
}

const fieldText = (name: string): string =>
  screen.getByTestId(`cr.evidence.field.${name}`).textContent ?? "";

describe("the §2.9 receipt renders every field exactly as supplied", () => {
  it("renders the recipe, run, output, and tree fields verbatim", () => {
    render(<EvidenceInspect {...inspectProps()} />);
    expect(screen.getByTestId("cr.evidence.receipt")).toBeDefined();
    expect(screen.getByTestId("cr.evidence.recipe")).toBeDefined();
    const argv = screen.getByTestId("cr.evidence.field.argv");
    expect([...argv.querySelectorAll("[data-testid^='cr.evidence.argv.']")]
      .map((node) => node.textContent))
      .toEqual(["pnpm", "--filter", "@moe/api", "test:contract"]);
    expect(fieldText("cwd")).toBe("D:/projexts/moe-next");
    expect(fieldText("env")).toBe("env:node22.14.0/pnpm10.4.1");
    expect(fieldText("started")).toBe("2026-08-09T09:40:21.000Z");
    expect(fieldText("ended")).toBe("2026-08-09T09:41:02.000Z");
    expect(fieldText("exit")).toBe("0");
    expect(fieldText("output-tail")).toBe("4 passed, 0 failed");
  });

  it("prints every digest and SHA in full, never elided", () => {
    const { container } = render(<EvidenceInspect {...inspectProps()} />);
    expect(fieldText("output-digest")).toBe(OUTPUT_DIGEST);
    expect(fieldText("base-sha")).toBe(BASE_SHA);
    expect(fieldText("head-sha")).toBe(HEAD_SHA);
    expect(fieldText("dirty-digest")).toBe(DIRTY_DIGEST);
    const shown = container.textContent ?? "";
    // An ellipsis anywhere here means some hash was shortened into incomparability.
    expect(shown).not.toContain("…");
    expect(shown).not.toContain("...");
  });

  it("renders each artifact digest in full and UNKNOWN where none was stated", () => {
    render(<EvidenceInspect {...inspectProps()} />);
    const openapi = screen.getByTestId("cr.evidence.artifact.openapi.diff");
    expect(within(openapi).getByTestId("cr.evidence.digest").textContent).toBe(OPENAPI_DIGEST);
    const bench = screen.getByTestId("cr.evidence.artifact.bench.json");
    const benchDigest = within(bench).getByTestId("cr.evidence.digest");
    expect(benchDigest.textContent).toBe(UNSTATED);
    expect(benchDigest.getAttribute("data-provenance")).toBe("ABSENT");
  });
});

describe("a failed run is reported as a failed run", () => {
  it("renders a non-zero exit as itself and softens nothing", () => {
    const receipt = receiptOf({
      run: { endedAt: "2026-08-09T09:41:02.000Z", exitCode: 2, startedAt: "2026-08-09T09:40:21.000Z" },
    });
    const { container } = render(<EvidenceInspect {...inspectProps({ receipt })} />);
    expect(fieldText("exit")).toBe("2");
    const shown = (container.textContent ?? "").toLowerCase();
    for (const softener of ["passed with warnings", "mostly", "partial success", "non-blocking"]) {
      expect(shown).not.toContain(softener);
    }
  });

  it("renders UNKNOWN for an exit code the daemon did not state", () => {
    const receipt = receiptOf({ run: { endedAt: null, exitCode: null, startedAt: null } });
    render(<EvidenceInspect {...inspectProps({ receipt })} />);
    for (const field of ["exit", "started", "ended"]) {
      const cell = screen.getByTestId(`cr.evidence.field.${field}`);
      expect(cell.textContent).toBe(UNSTATED);
      expect(cell.getAttribute("data-provenance")).toBe("ABSENT");
    }
  });

  it("renders the receipt claim as UNKNOWN when no summary value was supplied", () => {
    const receipt = receiptOf({ output: { digest: null, tail: null } });
    render(<EvidenceInspect {...inspectProps({ receipt })} />);
    const claim = screen.getByTestId("cr.fact.evidence.rcpt-4819.result");
    expect(within(claim).getByTestId("cr.value").textContent).toBe(UNKNOWN_FACT_VALUE);
  });
});

describe("DoD 1: every rendered fact carries provenance and the cursor it was read at", () => {
  it("renders actor, session, effect, command, aggregate and the cursor position", () => {
    render(<EvidenceInspect {...inspectProps()} />);
    expect(screen.getByTestId("cr.evidence.provenance.actor").textContent).toBe("daemon/runner");
    expect(screen.getByTestId("cr.evidence.provenance.session").textContent).toBe("session-w-3");
    expect(screen.getByTestId("cr.evidence.provenance.effect").textContent).toBe("eff-4819");
    expect(screen.getByTestId("cr.evidence.provenance.command").textContent).toBe("cmd-4819");
    expect(screen.getByTestId("cr.evidence.provenance.aggregate").textContent).toBe("api-endpnt");
    expect(screen.getByTestId("cr.evidence.cursor").textContent).toBe("applied #4819 of #4819 · live");
  });

  it("marks an absent provenance field ABSENT rather than borrowing another", () => {
    const receipt = receiptOf({ provenance: provenanceOf({ effectId: null, sessionId: null }) });
    render(<EvidenceInspect {...inspectProps({ receipt })} />);
    for (const field of ["effect", "session"]) {
      const cell = screen.getByTestId(`cr.evidence.provenance.${field}`);
      expect(cell.textContent).toBe(UNSTATED);
      expect(cell.getAttribute("data-provenance")).toBe("ABSENT");
    }
    expect(screen.getByTestId("cr.evidence.provenance.actor").textContent).toBe("daemon/runner");
  });

  it("gives the receipt claim exactly one truth chip", () => {
    const { container } = render(<EvidenceInspect {...inspectProps()} />);
    expect(container.querySelectorAll("[data-testid^='cr.fact.']").length).toBe(1);
    expect(container.querySelectorAll("[data-testid^='cr.chip.']").length).toBe(1);
  });
});

describe("inspection offers no way to alter or upgrade the evidence", () => {
  it("renders no command affordance at all", () => {
    const { container } = render(<EvidenceInspect {...inspectProps()} />);
    expect(container.querySelectorAll("[data-testid^='cr.action.']").length).toBe(0);
    // The only button a read-only surface may hold is the structural truth chip.
    for (const button of container.querySelectorAll("button")) {
      expect(button.getAttribute("data-testid") ?? "").toMatch(/^cr\.chip\./u);
    }
  });

  it("shows a comparison only when the daemon supplied one", () => {
    render(<EvidenceInspect {...inspectProps()} />);
    expect(screen.getByTestId("cr.evidence.compare").textContent).toBe("No comparison supplied.");
    cleanup();
    render(<EvidenceInspect {...inspectProps({
      comparison: { againstReceiptId: "rcpt-4770", statedOutcome: "OUTPUT_DIGEST_DIFFERS" },
    })} />);
    const compare = screen.getByTestId("cr.evidence.compare");
    expect(compare.textContent).toContain("rcpt-4770");
    expect(compare.textContent).toContain("OUTPUT_DIGEST_DIFFERS");
  });
});

describe("rejections and session messages stay visible without gaining authority", () => {
  it("renders a rejection with its daemon reason code and the layer that refused", () => {
    render(<EvidenceInspect {...inspectProps({
      rejection: {
        detail: "epoch 6 is behind current epoch 7",
        reasonCode: "LEASE_EPOCH_STALE",
        refusedLayer: "AUTHORITY",
      },
    })} />);
    const rejection = screen.getByTestId("cr.evidence.rejection");
    expect(rejection.textContent).toContain("LEASE_EPOCH_STALE");
    expect(rejection.textContent).toContain("AUTHORITY");
    expect(rejection.textContent).toContain("epoch 6 is behind current epoch 7");
  });

  it("renders a typed session message as advisory-only with authority NONE", () => {
    render(<EvidenceInspect {...inspectProps({
      sessionMessages: [{
        message: { kind: "SESSION", text: "worker w-2 reports the retry path is flaky" },
        receipt: { advisoryOnly: true, authority: "NONE", kind: "SESSION", outcome: "RECORDED" },
      }],
    })} />);
    const entry = screen.getByTestId("cr.evidence.session.0");
    expect(within(entry).getByTestId("cr.evidence.session.text").textContent)
      .toBe("worker w-2 reports the retry path is flaky");
    // These two literals are the entire mechanism that keeps the message inert.
    expect(within(entry).getByTestId("cr.evidence.session.authority").textContent).toBe("NONE");
    expect(within(entry).getByTestId("cr.evidence.session.advisory").textContent)
      .toBe("advisory only");
    expect(within(entry).getByTestId("cr.evidence.session.kind").textContent).toBe("SESSION");
  });

  it("states plainly when no session message was recorded", () => {
    render(<EvidenceInspect {...inspectProps()} />);
    expect(screen.getByTestId("cr.evidence.sessions").textContent)
      .toBe("No session messages recorded.");
  });
});
