import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NewGoalForm, PRD_FILE_PREFLIGHT_MAX_BYTES } from "./new-goal-form.js";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function readyForm(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Build the product");
  await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Meet the PRD");
  return user;
}

function createButton(): HTMLButtonElement {
  return screen.getByTestId("cr.goals.newgoal.create") as HTMLButtonElement;
}

describe("PRD selection must be resolved before creating a goal", () => {
  it.each(["unreadable", "oversize"] as const)("requires explicit removal after an %s file", async (failure) => {
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);
    const user = await readyForm();
    const file = new File([failure === "oversize" ? "x".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1) : "PRD"], "prd.md");
    if (failure === "unreadable") Object.defineProperty(file, "text", { value: async () => { throw new Error("unreadable"); } });
    const input = screen.getByTestId("cr.goals.newgoal.prd.input") as HTMLInputElement;
    await user.upload(input, file);
    await waitFor(() => expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent).toContain("PRD_FILE_"));
    expect(createButton().disabled).toBe(true);
    await user.click(createButton());
    expect(onCreate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove PRD" }));
    expect(input.value).toBe("");
    expect(screen.queryByTestId("cr.goals.newgoal.prd.status")).toBeNull();
    expect(createButton().disabled).toBe(false);
    await user.click(createButton());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("prd");
  });

  it("allows a successfully read replacement to resolve a failed selection", async () => {
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);
    const user = await readyForm();
    const input = screen.getByTestId("cr.goals.newgoal.prd.input");
    await user.upload(input, new File(["x".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1)], "large.md"));
    expect(createButton().disabled).toBe(true);
    await user.upload(input, new File(["replacement bytes"], "replacement.md"));
    await waitFor(() => expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent).toContain("replacement.md"));
    expect(createButton().disabled).toBe(false);
    await user.click(createButton());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ prd: { name: "replacement.md", text: "replacement bytes" } });
  });

  it("allows the same file to be selected after explicit removal", async () => {
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);
    const user = await readyForm();
    const file = new File(["PRD bytes"], "prd.md");
    const input = screen.getByTestId("cr.goals.newgoal.prd.input");
    await user.upload(input, file);
    await screen.findByTestId("cr.goals.newgoal.prd.file");
    await user.click(screen.getByRole("button", { name: "Remove PRD" }));
    await user.upload(input, file);
    await screen.findByTestId("cr.goals.newgoal.prd.file");
    await user.click(createButton());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ prd: { name: "prd.md", text: "PRD bytes" } });
  });

  it.each(["remove", "reset"] as const)("ignores a pending digest after %s", async (action) => {
    let resolveDigest!: (value: ArrayBuffer) => void;
    const digest = vi.fn(() => new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve; }));
    vi.stubGlobal("crypto", { subtle: { digest } });
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<NewGoalForm onCancel={onCancel} onCreate={onCreate} resetToken={0} />);
    const user = await readyForm();
    const input = screen.getByTestId("cr.goals.newgoal.prd.input") as HTMLInputElement;
    await user.upload(input, new File(["stale bytes"], "stale.md"));
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
    expect(createButton().disabled).toBe(true);
    if (action === "remove") await user.click(screen.getByRole("button", { name: "Remove PRD" }));
    else rerender(<NewGoalForm onCancel={onCancel} onCreate={onCreate} resetToken={1} />);
    await act(async () => { resolveDigest(new Uint8Array(32).buffer); });
    expect(input.value).toBe("");
    expect(screen.queryByTestId("cr.goals.newgoal.prd.file")).toBeNull();
    expect(screen.queryByTestId("cr.goals.newgoal.prd.status")).toBeNull();
    if (action === "reset") await readyForm();
    await user.click(createButton());
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("prd");
  });

  it("describes the budget field as an advisory request", () => {
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByLabelText("Requested budget")).toBe(screen.getByTestId("cr.goals.newgoal.budget"));
    const note = screen.getByTestId("cr.goals.newgoal.authority-note").textContent;
    expect(note).toContain("advisory instructions");
    expect(note).toContain("admitted spending cap");
    expect(note).toContain("measured consumption");
  });
});
