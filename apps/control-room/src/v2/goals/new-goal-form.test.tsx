import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NewGoalForm } from "./new-goal-form.js";

/**
 * The new-goal form's PRD drop remains local until a goal-bound ingest contract
 * exists. Merely selecting, dropping, cancelling, or creating must never read
 * or upload the file through the retired eager-ingest callback.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("the PRD consent boundary", () => {
  it("keeps a dropped file local even when a stale caller supplies the retired ingest callback", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCreate = vi.fn();
    const onIngestPrd = vi.fn().mockResolvedValue({ status: "INGESTED" });
    const staleProps = { onCancel, onCreate, onIngestPrd };
    render(<NewGoalForm {...staleProps} />);

    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    const read = vi.spyOn(file, "text");
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(onIngestPrd).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("cr.goals.newgoal.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onIngestPrd).not.toHaveBeenCalled();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
  });

  it("does not create an orphan upload when Create goal is pressed", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onIngestPrd = vi.fn().mockResolvedValue({ status: "INGESTED" });
    render(<NewGoalForm {...{ onCancel: vi.fn(), onCreate, onIngestPrd }} />);

    const file = new File(["private product plan"], "private.txt", { type: "text/plain" });
    const read = vi.spyOn(file, "text");
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    expect(read).not.toHaveBeenCalled();
    expect(onIngestPrd).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      prd: { name: "private.txt", size: 20 },
    }));
  });
});

describe("the local-only PRD drop", () => {
  it("shows metadata and an accurate local-only note without seeding operator prose", async () => {
    const user = userEvent.setup();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);

    const file = new File(["# PRD\nbuild it"], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    const shown = screen.getByTestId("cr.goals.newgoal.prd.file");
    expect(shown.textContent).toContain("prd.md");
    expect(shown.textContent).toContain("PRD upload is unavailable");
    expect(screen.queryByTestId("cr.goals.newgoal.prd.status")).toBeNull();
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
  });
});
