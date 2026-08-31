import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GOAL_BRIEF_LIMITS } from "@moe/contracts";

import { NewGoalForm, PRD_FILE_PREFLIGHT_MAX_BYTES } from "./new-goal-form.js";
import { readGoalPrdFile } from "./use-goal-prd.js";

/**
 * The new-goal form's PRD drop. The file is read ENTIRELY in the browser: the form
 * reaches no route at all, so selecting a PRD writes nothing to the daemon or its
 * store. Every arm pins that with a fetch stub that throws if it is ever called.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** sha256 of the exact bytes each fixture file carries, computed out of band. */
const PRD_MD_SHA256 = "992ddf7be007d0fdfa7737b405c1d5e1c899800b8ed5f4e427d9088be07f41fd";
const PRD_MD_TEXT = "# PRD\nbuild it";

/** Any daemon call from this form would show up here; every arm asserts it stayed empty. */
function stubFetchThatMustNotBeCalled(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(() => { throw new Error("the new-goal form must not call any route"); });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("the PRD drop reads in the browser and writes nothing", () => {
  it("returns the exact oversize refusal before reading or digesting bytes", async () => {
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal("crypto", { subtle: { digest } });
    const file = new File(
      ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1)],
      "too-large.md",
      { type: "text/markdown" },
    );
    const text = vi.fn(async () => "must not be read");
    Object.defineProperty(file, "text", { value: text });

    await expect(readGoalPrdFile(file)).resolves.toStrictEqual({
      code: "PRD_FILE_TOO_LARGE",
      layer: "CONTROL_ROOM_NEWGOAL",
      status: "ERROR",
    });
    expect(text).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a browser read rejection to the exact local unreadable refusal", async () => {
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const digest = vi.fn(async () => new Uint8Array(32).buffer);
    vi.stubGlobal("crypto", { subtle: { digest } });
    const file = new File(["read me"], "unreadable.md", { type: "text/markdown" });
    const text = vi.fn(async () => { throw new Error("hostile read rejection"); });
    Object.defineProperty(file, "text", { value: text });

    await expect(readGoalPrdFile(file)).resolves.toStrictEqual({
      code: "PRD_FILE_UNREADABLE",
      layer: "CONTROL_ROOM_NEWGOAL",
      status: "ERROR",
    });
    expect(text).toHaveBeenCalledTimes(1);
    expect(digest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a browser digest rejection to the exact local unreadable refusal", async () => {
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const digest = vi.fn(async () => { throw new Error("hostile digest rejection"); });
    vi.stubGlobal("crypto", { subtle: { digest } });
    const file = new File(["digest me"], "digest.md", { type: "text/markdown" });

    await expect(readGoalPrdFile(file)).resolves.toStrictEqual({
      code: "PRD_FILE_UNREADABLE",
      layer: "CONTROL_ROOM_NEWGOAL",
      status: "ERROR",
    });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the exact browser draft after reading and digesting a file", async () => {
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const file = new File([PRD_MD_TEXT], "prd.md", { type: "text/plain" });

    await expect(readGoalPrdFile(file)).resolves.toStrictEqual({
      prd: {
        name: "prd.md",
        sha256: PRD_MD_SHA256,
        size: 14,
        text: PRD_MD_TEXT,
      },
      status: "READ",
      submittedPrd: {
        localSha256: PRD_MD_SHA256,
        mediaType: "text/markdown",
        name: "prd.md",
        size: 14,
        text: PRD_MD_TEXT,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the current unreadable refusal when a superseded digest resolves late", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const onCreate = vi.fn();
    let resolveDigest!: (value: ArrayBuffer) => void;
    const digest = vi.fn(() => new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve;
    }));
    vi.stubGlobal("crypto", { subtle: { digest } });
    const first = new File(["stale bytes"], "stale.md", { type: "text/markdown" });
    const current = new File(["current bytes"], "current.md", { type: "text/markdown" });
    Object.defineProperty(current, "text", {
      value: vi.fn(async () => { throw new Error("current file is unreadable"); }),
    });
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);
    const input = screen.getByTestId("cr.goals.newgoal.prd.input");

    await user.upload(input, first);
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(1));
    await user.upload(input, current);
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toBe("Error - PRD_FILE_UNREADABLE @ CONTROL_ROOM_NEWGOAL");
    });
    await act(async () => {
      resolveDigest(new Uint8Array(32).buffer);
      await Promise.resolve();
    });

    expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
      .toBe("Error - PRD_FILE_UNREADABLE @ CONTROL_ROOM_NEWGOAL");
    expect(screen.queryByTestId("cr.goals.newgoal.prd.file")).toBeNull();
    expect(screen.queryByText("stale.md")).toBeNull();
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Proceed without the PRD");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Proceed without the PRD");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("prd");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an over-limit file before reading any browser bytes", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const file = new File(
      ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES + 1)],
      "too-large.md",
      { type: "text/markdown" },
    );
    const read = vi.fn(() => Promise.resolve("must not be read"));
    Object.defineProperty(file, "text", { value: read });
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);

    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
      .toContain("PRD_FILE_TOO_LARGE");
    expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
      .toContain("CONTROL_ROOM_NEWGOAL");
    expect(read).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads an exact-limit file entirely in the browser", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const file = new File(
      ["a".repeat(PRD_FILE_PREFLIGHT_MAX_BYTES)],
      "at-limit.md",
      { type: "text/markdown" },
    );
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);

    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent).toContain("Read");
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the digest of the bytes it read and attaches them to the draft", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    const file = new File([PRD_MD_TEXT], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain(PRD_MD_SHA256);
    });
    // A locally computed digest is never presented as a daemon ingest receipt.
    expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
      .not.toContain("Ingested");
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Adopt the recovery contract");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Adopt the recovery contract");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      prd: { localSha256: PRD_MD_SHA256, name: "prd.md", size: 14 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The bytes must SURVIVE to the create callback, not merely be read. The goal
   * source travels inside the goal-creation command, so a draft that carries only
   * the digest leaves the dispatcher with nothing to send. `toEqual` pins the EXACT
   * key set on purpose: re-stripping any member reds this arm.
   */
  it("carries the read bytes and the derived media type to the create callback", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    const file = new File([PRD_MD_TEXT], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain(PRD_MD_SHA256);
    });

    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Adopt the recovery contract");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Adopt the recovery contract");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const draft = onCreate.mock.calls[0]?.[0] as { readonly prd?: unknown };
    expect(draft.prd).toEqual({
      localSha256: PRD_MD_SHA256,
      mediaType: "text/markdown",
      name: "prd.md",
      size: 14,
      text: PRD_MD_TEXT,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The media type is DERIVED from the name this browser read, never from the
   * `type` the platform claimed - a `.md` file reports an empty type on several
   * hosts. A second extension keeps the derivation from collapsing to a constant.
   */
  it("derives text/plain for a non-markdown name while the platform claims markdown", async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetchThatMustNotBeCalled();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    const file = new File([PRD_MD_TEXT], "prd.txt", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);
    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain(PRD_MD_SHA256);
    });

    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Adopt the recovery contract");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Adopt the recovery contract");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    const draft = onCreate.mock.calls[0]?.[0] as { readonly prd?: { readonly mediaType?: string } };
    expect(draft.prd?.mediaType).toBe("text/plain");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attaches no PRD and names the local code when the file cannot be read", async () => {
    const user = userEvent.setup();
    stubFetchThatMustNotBeCalled();
    const onCreate = vi.fn();
    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => Promise.reject(new Error("no")) });
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.status").textContent)
        .toContain("PRD_FILE_UNREADABLE");
    });
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Proceed without the PRD");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Proceed without the PRD");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));
    // An unread file is not project material; it must not ride the draft at all.
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("prd");
  });

  it("never seeds the outcome with prose the operator did not type", async () => {
    const user = userEvent.setup();
    stubFetchThatMustNotBeCalled();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);

    const file = new File([PRD_MD_TEXT], "prd.md", { type: "text/markdown" });
    await user.upload(screen.getByTestId("cr.goals.newgoal.prd.input"), file);

    await waitFor(() => {
      expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent).toContain("prd.md");
    });
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("cr.goals.newgoal.prd.file").textContent)
      .not.toContain("Moe will read this once ingest is wired");
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
    // An outcome alone is not enough: the shared brief contract requires a title too.
    expect(create.disabled).toBe(true);
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Start a Windows project");
    expect(create.disabled).toBe(false);
    expect(screen.getByTestId("cr.goals.newgoal.authority-note").textContent)
      .toContain("advisory requests");
    await user.click(create);
    const draft = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draft["budgetEnvelope"]).toBe("");
    expect(draft).not.toHaveProperty("riskClass");
  });
});

describe("the title the operator types is the title the goal carries", () => {
  it("submits the trimmed title alongside the outcome", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Behind bearer credentials");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "  Ship stdio entry  ");
    await user.click(screen.getByTestId("cr.goals.newgoal.create"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      outcome: "Behind bearer credentials",
      title: "Ship stdio entry",
    });
  });

  it("keeps Create unavailable while the title is whitespace only", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewGoalForm onCancel={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Behind bearer credentials");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "   ");
    expect((screen.getByTestId("cr.goals.newgoal.create") as HTMLButtonElement).disabled).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("lets the title exceed nothing the contract does not, so the contract stays the authority", () => {
    render(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} />);
    const title = screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement;
    // Deliberately looser than GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes (1024): an over-limit
    // title must reach `admitGoalBrief` and be refused there, not be silently truncated here.
    expect(title.maxLength).toBeGreaterThan(GOAL_BRIEF_LIMITS.maxTitleUtf8Bytes);
  });
});

describe("only the parent can discard the operator's draft", () => {
  it("clears every field when the parent bumps the reset token", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} resetToken={0} />,
    );
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Behind bearer credentials");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Ship stdio entry");
    await user.type(screen.getByTestId("cr.goals.newgoal.criteria"), "pnpm test exits 0");
    await user.type(screen.getByTestId("cr.goals.newgoal.budget"), "90 min");

    rerender(<NewGoalForm onCancel={vi.fn()} onCreate={vi.fn()} resetToken={1} />);

    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.criteria") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByTestId("cr.goals.newgoal.budget") as HTMLInputElement).value).toBe("");
  });

  it("keeps every field when the parent re-renders with an unchanged reset token", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <NewGoalForm busy={false} onCancel={vi.fn()} onCreate={vi.fn()} resetToken={4} />,
    );
    await user.type(screen.getByTestId("cr.goals.newgoal.outcome"), "Behind bearer credentials");
    await user.type(screen.getByTestId("cr.goals.newgoal.title"), "Ship stdio entry");
    await user.type(screen.getByTestId("cr.goals.newgoal.budget"), "90 min");

    // A refusal re-renders the form (busy flips back) but never advances the token.
    rerender(<NewGoalForm busy onCancel={vi.fn()} onCreate={vi.fn()} resetToken={4} />);
    rerender(<NewGoalForm busy={false} onCancel={vi.fn()} onCreate={vi.fn()} resetToken={4} />);

    expect((screen.getByTestId("cr.goals.newgoal.title") as HTMLInputElement).value)
      .toBe("Ship stdio entry");
    expect((screen.getByTestId("cr.goals.newgoal.outcome") as HTMLInputElement).value)
      .toBe("Behind bearer credentials");
    expect((screen.getByTestId("cr.goals.newgoal.budget") as HTMLInputElement).value).toBe("90 min");
  });
});
