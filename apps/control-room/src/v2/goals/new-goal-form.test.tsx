import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DocumentIngestOutcome } from "../../live/live-document-ingest.js";
import { NewGoalForm, PRD_FILE_PREFLIGHT_MAX_BYTES } from "./new-goal-form.js";

/**
 * The new-goal form's PRD drop (UI-4). Two paths are exercised: the WIRED path
 * (an onIngestPrd is supplied) actually reads the file and reflects the daemon's
 * answer; the UNWIRED path keeps the honest placeholder and never reads or sends.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const INGESTED: DocumentIngestOutcome = {
  byteLength: 14,
  candidateTitle: "Write the recovery contract",
  contentSha256: "a".repeat(64),
  status: "INGESTED",
};

describe("the PRD drop with a wired ingest action", () => {
  it("refuses an over-limit file before reading any browser bytes", async () => {
    const user = userEvent.setup();
    const onIngestPrd = vi.fn();
    const file = new File(
      ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1)],
      "too-large.md",
      { type: "text/markdown" },
    );
    const read = vi.fn(() => Promise.resolve("must not be read"));
    Object.defineProperty(file, "text", { value: read });
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} onIngestPrd={onIngestPrd} />);

    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
      .toContain("PRD_FILE_TOO_LARGE");
    expect(read).not.toHaveBeenCalled();
    expect(onIngestPrd).not.toHaveBeenCalled();
  });

  it("allows an exact-limit file to reach the daemon authority", async () => {
    const user = userEvent.setup();
    const onIngestPrd = vi.fn<(request: unknown) => Promise<DocumentIngestOutcome>>()
      .mockResolvedValue(INGESTED);
    const file = new File(
      ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES)],
      "at-limit.md",
      { type: "text/markdown" },
    );
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} onIngestPrd={onIngestPrd} />);

    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => { expect(onIngestPrd).toHaveBeenCalledTimes(1); });
    expect((onIngestPrd.mock.calls[0]?.[0] as { text: string }).text).toHaveLength(
      PRD_FILE_PREFLIGHT_MAX_BYTES,
    );
  });

  it("reads the file, calls ingest once with the allow-list, and seeds the outcome", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onIngestPrd = vi.fn<(request: unknown) => Promise<DocumentIngestOutcome>>()
      .mockResolvedValue(INGESTED);
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} onIngestPrd={onIngestPrd} />);

    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => { expect(onIngestPrd).toHaveBeenCalledTimes(1); });
    expect(onIngestPrd.mock.calls[0]?.[0]).toStrictEqual({
      displayPath: "prd.md",
      mediaType: "text/markdown",
      text: "# PRD\nbuild it",
    });

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain("Write the recovery contract");
    });
    // The empty outcome is seeded with the REAL daemon candidate title, not a placeholder.
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe("Write the recovery contract");
    // The misleading "ingest not wired" note is gone on the wired path.
    expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent)
      .not.toContain("Moe will read this once ingest is wired");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      prd: {
        contentSha256: "a".repeat(64),
        name: "prd.md",
        size: 14,
        status: "INGESTED",
      },
    });
  });

  it("derives text/plain for a non-.md file", async () => {
    const user = userEvent.setup();
    const onIngestPrd = vi.fn<(request: unknown) => Promise<DocumentIngestOutcome>>()
      .mockResolvedValue(INGESTED);
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} onIngestPrd={onIngestPrd} />);

    const file = new File(["plain body"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => { expect(onIngestPrd).toHaveBeenCalledTimes(1); });
    expect(onIngestPrd.mock.calls[0]?.[0]).toMatchObject({ mediaType: "text/plain" });
  });

  it("shows a refusal code verbatim without seeding the outcome", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onIngestPrd = vi.fn<(request: unknown) => Promise<DocumentIngestOutcome>>()
      .mockResolvedValue({
        code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID",
        layer: "DAEMON_INGRESS",
        status: "REFUSED",
      });
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} onIngestPrd={onIngestPrd} />);

    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain("DOCUMENT_WORK_INGEST_PAYLOAD_INVALID");
    });
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Proceed without the refused PRD");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      prd: {
        code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID",
        name: "prd.md",
        size: 5,
        status: "NOT_INGESTED",
      },
    });
  });
});

describe("the PRD drop without a wired ingest action", () => {
  it("keeps the placeholder note, never reads, and shows no status region", async () => {
    const user = userEvent.setup();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);

    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    const shown = screen.getByTestId("cr.goals.newgoal.prd.file");
    expect(shown.textContent).toContain("prd.md");
    expect(shown.textContent).toContain("Moe will read this once ingest is wired");
    expect(screen.queryByTestId("cr.goals.newgoal.prd.status")).toBeNull();
    // The placeholder outcome is the marked one, not a daemon candidate title.
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toContain("prd.md");
  });
});

describe("goal intake validation", () => {
  it("requires a non-empty outcome before Create goal is available", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    const create = screen.getByTestId("cr.goals.newgoal.create") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect((screen.getByTestId("cr.goals.newgoal.budget") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.risk") as HTMLSelectElement).value).toBe("");
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Start a Windows project");
    expect(create.disabled).toBe(false);
    expect(screen.getByTestId("cr.goals.newgoal.authority-note").textContent)
      .toContain("advisory requests");
    await user.click(create);
    const draft = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draft["budgetEnvelope"]).toBe("");
    expect(draft).not.toHaveProperty("riskClass");
  });
});
