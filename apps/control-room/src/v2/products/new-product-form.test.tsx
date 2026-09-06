import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  BootstrapReceiptState, BootstrapReceiptView,
} from "../../live/live-bootstrap-receipt.js";
import type { GoalDraft } from "../goals/goal-model.js";
import type { NewProductRequest, NewProductRun } from "./live-new-product.js";
import { DEFAULT_VISIBILITY, NewProductForm, newProductWords } from "./new-product-form.js";

/** GitHub stays optional and partial success preserves local work.
 * This presentation form must reach no route. */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetchThatMustNotBeCalled(): void {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("the new-product form must not call a route"); }));
}

const RECEIPT: BootstrapReceiptView = Object.freeze({
  decidedAt: "2026-09-06T09:00:00.000Z",
  dir: "D:/projects/demo",
  githubRefusal: null,
  outcome: "BOOTSTRAPPED",
  refusal: null,
  remoteUrl: null,
  sha: "a".repeat(40),
  version: "moe.repository.bootstrap.receipt.v1",
});

const GH_REFUSAL = Object.freeze({
  code: "BOOTSTRAP_GH_UNAVAILABLE", detail: "GH_EXECUTABLE_ABSENT", refusedBy: "DAEMON_INGRESS",
});

const runOf = (bootstrap: BootstrapReceiptState): NewProductRun => Object.freeze({
  bootstrap, chain: [], dispatch: { commandId: "command-1", ok: true as const }, goal: null,
});

/** Hard refusal is the positive control for this destructive-wording matcher. */
const DESTRUCTIVE_WORDING = /bootstrap failed|was not created|could not be created/iu;
describe("the GitHub half is visibly optional and the local-only path is reachable", () => {
  it("says optional in the labels and submits with every GitHub field empty", async () => {
    stubFetchThatMustNotBeCalled();
    const seen: { request: NewProductRequest; draft: GoalDraft | null }[] = [];
    render(<NewProductForm onCreate={(request, draft) => seen.push({ draft, request })} />);

    // In the LABELS, not only a tooltip.
    expect(screen.getByTestId("cr.newproduct.github").textContent).toContain("optional");
    expect(screen.getByText("GitHub owner (optional)")).not.toBeNull();
    expect(screen.getByTestId("cr.newproduct.github.note").textContent)
      .toContain("Nothing is sent to GitHub unless you type an owner");

    await userEvent.type(screen.getByTestId("cr.newproduct.dir"), "D:/projects/demo");
    await userEvent.type(screen.getByTestId("cr.newproduct.name"), "demo");
    await userEvent.click(screen.getByTestId("cr.newproduct.create"));

    expect(seen).toHaveLength(1);
    const request = seen[0]?.request as NewProductRequest;
    expect(request.dir).toBe("D:/projects/demo");
    expect(request.productName).toBe("demo");
    // ABSENT, not empty. An empty object asks for a repository named nothing.
    expect(Object.hasOwn(request, "github")).toBe(false);
    expect(Object.keys(request).sort()).toEqual(["dir", "productName"]);
    expect(seen[0]?.draft).toBeNull();
  });

  it("requests the GitHub half only once an owner is typed, and never invents one", async () => {
    stubFetchThatMustNotBeCalled();
    const seen: NewProductRequest[] = [];
    render(<NewProductForm onCreate={(request) => seen.push(request)} />);

    await userEvent.type(screen.getByTestId("cr.newproduct.dir"), "D:/projects/demo");
    await userEvent.type(screen.getByTestId("cr.newproduct.name"), "demo");
    await userEvent.type(screen.getByTestId("cr.newproduct.github.owner"), "an-owner");
    await userEvent.click(screen.getByTestId("cr.newproduct.create"));

    expect(seen[0]?.github).toEqual({
      name: "demo", owner: "an-owner", visibility: "private",
    });
  });
});

describe("visibility cannot default to a public repository", () => {
  it("defaults to private in the constant and in the mounted control", () => {
    stubFetchThatMustNotBeCalled();
    // The constant, asserted directly: this default is not recoverable once it is wrong.
    expect(DEFAULT_VISIBILITY).toBe("private");
    expect(DEFAULT_VISIBILITY).not.toBe("public");
    render(<NewProductForm onCreate={() => undefined} />);
    const select = screen.getByTestId("cr.newproduct.github.visibility") as HTMLSelectElement;
    expect(select.value).toBe("private");
    // Public is offered, because an operator may choose it. It is never the resting state.
    expect([...select.options].map((option) => option.value))
      .toEqual(["private", "internal", "public"]);
  });
});

describe("the four outcomes render as operator words with their codes verbatim", () => {
  it("names a hard refusal, its detail and the layer that refused", () => {
    stubFetchThatMustNotBeCalled();
    const refusal = {
      code: "BOOTSTRAP_DIR_NOT_EMPTY", detail: "DIRECTORY_NOT_EMPTY", refusedBy: "DAEMON_INGRESS",
    };
    render(<NewProductForm onCreate={() => undefined} run={runOf({
      receipt: { ...RECEIPT, outcome: "REFUSED", refusal, sha: null, remoteUrl: null },
      refusal, state: "REFUSED",
    })} />);
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(detail).toContain("BOOTSTRAP_DIR_NOT_EMPTY");
    expect(detail).toContain("DIRECTORY_NOT_EMPTY");
    expect(detail).toContain("DAEMON_INGRESS");
    expect(screen.getByTestId("cr.newproduct.outcome").getAttribute("data-state")).toBe("ERROR");
    // POSITIVE CONTROL for the partial-success arm, over the SAME two lines that arm reads:
    // the matcher really does fire on wording that tells an operator nothing was made, and a
    // hard refusal is exactly where that wording belongs.
    const headline = screen.getByTestId("cr.newproduct.outcome.headline").textContent ?? "";
    expect(headline).toBe("The product was not created.");
    expect(`${headline} ${detail}`).toMatch(DESTRUCTIVE_WORDING);
  });

  it.each(["BIND", "CATALOG"])("reports the actual binding state after retained %s failure", (stage) => {
    stubFetchThatMustNotBeCalled();
    const refusal = {
      code: `BOOTSTRAP_${stage}_FAILED`, detail: `${stage}_FAILED_LOCAL_REPOSITORY_RETAINED`,
      refusedBy: "DAEMON_INGRESS",
    };
    render(<NewProductForm onCreate={() => undefined} run={runOf({
      receipt: { ...RECEIPT, outcome: "REFUSED", refusal, sha: null, remoteUrl: null },
      refusal, state: "REFUSED",
    })} />);
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(detail).toContain(refusal.code);
    expect(detail).toContain(refusal.detail);
    expect(detail).toContain("still on disk");
    expect(detail).not.toContain("No repository was created");
    expect(screen.getByTestId("cr.newproduct.outcome.headline").textContent).not.toMatch(DESTRUCTIVE_WORDING);
    expect(detail).toContain(stage === "CATALOG" ? "is already bound" : "not bound");
    if (stage === "CATALOG") expect(detail).not.toContain("not bound");
  });

  it("names the read code when no receipt could be read, and calls it not a refusal", () => {
    stubFetchThatMustNotBeCalled();
    render(<NewProductForm onCreate={() => undefined} run={runOf({
      code: "BOOTSTRAP_RECEIPT_ABSENT", layer: "CONTROL_ROOM_BOOTSTRAP_RECEIPT",
      state: "NO_RECEIPT",
    })} />);
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(detail).toContain("BOOTSTRAP_RECEIPT_ABSENT");
    expect(detail).toContain("CONTROL_ROOM_BOOTSTRAP_RECEIPT");
    expect(detail).toContain("not a refusal");
    expect(screen.getByTestId("cr.newproduct.outcome").getAttribute("data-state")).toBe("UNKNOWN");
  });

  it("reports a full success with the directory and the first commit", () => {
    stubFetchThatMustNotBeCalled();
    render(<NewProductForm onCreate={() => undefined} run={runOf({
      receipt: { ...RECEIPT, remoteUrl: "https://github.com/an-owner/demo" },
      state: "FULL_SUCCESS",
    })} />);
    expect(screen.getByTestId("cr.newproduct.outcome.headline").textContent)
      .toBe("Product created.");
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(detail).toContain("D:/projects/demo");
    expect(detail).toContain("a".repeat(40));
    expect(detail).toContain("https://github.com/an-owner/demo");
    expect(screen.getByTestId("cr.newproduct.outcome").getAttribute("data-state")).toBe("SUCCESS");
  });
});

function readyForm(onCreate: (request: NewProductRequest, draft: GoalDraft | null) => void): void {
  stubFetchThatMustNotBeCalled();
  render(<NewProductForm onCreate={onCreate} />);
  fireEvent.change(screen.getByTestId("cr.newproduct.dir"), { target: { value: "D:/projects/demo" } });
  fireEvent.change(screen.getByTestId("cr.newproduct.name"), { target: { value: "demo" } });
}

it("does not submit a selected PRD while its bytes are still being read", async () => {
  const onCreate = vi.fn();
  readyForm(onCreate);
  let finish: (text: string) => void = () => { throw new Error("read not initialized"); };
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
  Object.defineProperty(file, "text", { value: () => pending });
  fireEvent.change(screen.getByTestId("cr.newproduct.prd"), { target: { files: [file] } });
  try {
    fireEvent.click(screen.getByTestId("cr.newproduct.create"));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByTestId("cr.newproduct.prd.status").textContent).toBe("Reading...");
  } finally { await act(async () => { finish("# PRD"); await pending; }); }
  await waitFor(() => expect((screen.getByTestId("cr.newproduct.create") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("cr.newproduct.create"));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ dir: "D:/projects/demo", productName: "demo" },
    expect.objectContaining({ prd: expect.objectContaining({ name: "prd.md", text: "# PRD" }) }));
});

it.each(["PRD_FILE_TOO_LARGE", "PRD_FILE_UNREADABLE"])("keeps %s visible and blocks submission until replacement", async (code) => {
  const onCreate = vi.fn();
  readyForm(onCreate);
  const file = new File(["x".repeat(code === "PRD_FILE_TOO_LARGE" ? 128 * 1024 + 1 : 1)], "bad.md");
  Object.defineProperty(file, "text", { value: async () => { throw new Error("read refused"); } });
  fireEvent.change(screen.getByTestId("cr.newproduct.prd"), { target: { files: [file] } });
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByTestId("cr.newproduct.create"));
  expect(onCreate).not.toHaveBeenCalled();
  expect(screen.getByTestId("cr.newproduct.prd.status").textContent).toBe(`Error - ${code} @ CONTROL_ROOM_NEWGOAL`);
  const replacement = new File(["good"], "good.md");
  Object.defineProperty(replacement, "text", { value: async () => "good" });
  fireEvent.change(screen.getByTestId("cr.newproduct.prd"), { target: { files: [replacement] } });
  await waitFor(() => expect((screen.getByTestId("cr.newproduct.create") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("cr.newproduct.create"));
  expect(onCreate).toHaveBeenCalledExactlyOnceWith({ dir: "D:/projects/demo", productName: "demo" },
    expect.objectContaining({ prd: expect.objectContaining({ name: "good.md", text: "good" }) }));
});

it.each(["activation", "goal"])("retains local success but reports the exact downstream %s refusal", (stage) => {
  stubFetchThatMustNotBeCalled();
  for (const github of [false, true]) {
    const bootstrap: BootstrapReceiptState = github
      ? { state: "PARTIAL_SUCCESS", receipt: { ...RECEIPT, githubRefusal: GH_REFUSAL }, githubRefusal: GH_REFUSAL }
      : { state: "FULL_SUCCESS", receipt: RECEIPT };
    const code = stage === "activation" ? "ACTIVATION_POLICY_UNMEASURED" : "GOAL_SOURCE_INVALID";
    const layer = stage === "activation" ? "DAEMON_ACTIVATION_RECEIPTS" : "DAEMON_INGRESS";
    const run: NewProductRun = { ...runOf(bootstrap),
      chain: stage === "activation" ? [{ kind: "project.activate", state: "ANSWERED", outcome: { ok: false, code, layer } }] : [],
      goal: stage === "goal" ? { ok: false, report: `${code} @ ${layer}` } : null };
    render(<NewProductForm onCreate={() => undefined} run={run} />);
    expect(screen.getByTestId("cr.newproduct.outcome").getAttribute("data-state")).toBe("PARTIAL");
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(detail).toContain("exists, is committed");
    expect(detail).toContain("is bound to this project");
    expect(detail).toContain(code); expect(detail).toContain(layer);
    if (github) expect(detail).toContain(GH_REFUSAL.code);
    expect(detail).not.toMatch(DESTRUCTIVE_WORDING);
    cleanup();
  }
});

/** A GitHub refusal must never tell an operator to discard the committed local repository. */
describe("BOOTSTRAP_GH_UNAVAILABLE renders as a partial success, never a failure", () => {
  it("says the repository exists and is bound, shows the code, and never says it failed", () => {
    stubFetchThatMustNotBeCalled();
    render(<NewProductForm onCreate={() => undefined} run={runOf({
      githubRefusal: GH_REFUSAL, receipt: { ...RECEIPT, githubRefusal: GH_REFUSAL },
      state: "PARTIAL_SUCCESS",
    })} />);

    const headline = screen.getByTestId("cr.newproduct.outcome.headline").textContent ?? "";
    const detail = screen.getByTestId("cr.newproduct.outcome.detail").textContent ?? "";
    expect(screen.getByTestId("cr.newproduct.outcome").getAttribute("data-state")).toBe("PARTIAL");

    // The repository is there, and the screen says so in those words.
    expect(detail).toContain("The repository at D:/projects/demo exists");
    expect(detail).toContain("is bound to this project");
    expect(detail).toContain("Keep it");
    // The code is shown ALONGSIDE the words, verbatim, with its detail.
    expect(detail).toContain("BOOTSTRAP_GH_UNAVAILABLE");
    expect(detail).toContain("GH_EXECUTABLE_ABSENT");
    // And the wording that would make an operator delete it is absent from BOTH lines. The
    // same matcher fired on the hard-refusal branch above, so this absence is not vacuous.
    expect(DESTRUCTIVE_WORDING.test("the bootstrap failed")).toBe(true);
    expect(`${headline} ${detail}`).not.toMatch(DESTRUCTIVE_WORDING);
  });

  it("classifies the same receipt as partial through the pure function too", () => {
    const words = newProductWords(runOf({
      githubRefusal: GH_REFUSAL, receipt: { ...RECEIPT, githubRefusal: GH_REFUSAL },
      state: "PARTIAL_SUCCESS",
    }));
    expect(words?.state).toBe("PARTIAL");
    expect(words?.detail).toContain("BOOTSTRAP_GH_UNAVAILABLE");
    expect(newProductWords(null)).toBeNull();
  });
});

describe("no credential reaches the form or anything it renders", () => {
  it("offers no credential-shaped input and renders no token or userinfo URL", () => {
    stubFetchThatMustNotBeCalled();
    const { container } = render(<NewProductForm onCreate={() => undefined} run={runOf({
      githubRefusal: GH_REFUSAL, receipt: { ...RECEIPT, githubRefusal: GH_REFUSAL },
      state: "PARTIAL_SUCCESS",
    })} />);

    expect(container.querySelectorAll("input[type=password]")).toHaveLength(0);
    for (const field of container.querySelectorAll("input, select, textarea")) {
      const named = `${field.id} ${field.getAttribute("name") ?? ""} `
        + `${field.getAttribute("data-testid") ?? ""}`;
      expect(named).not.toMatch(/credential|token|secret|password/iu);
    }
    expect(container.textContent ?? "").not.toMatch(
      /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|:\/\/[^/@\s"]+@/u,
    );
  });
});
