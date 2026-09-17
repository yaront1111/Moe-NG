import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { OutcomeNote } from "./outcome-note.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("OutcomeNote", () => {
  it("shows the sentence and keeps the code behind Details", () => {
    render(<OutcomeNote code="RUNS_READ_FAILED" layer="RUNS_READ" said="The nodes could not be read" testId="cr.note" />);
    const note = screen.getByTestId("cr.note");
    expect(note.querySelector(".cr2-outcome-said")?.textContent).toBe("The nodes could not be read");
    expect(note.querySelector("summary")?.textContent).toBe("Details");
    expect(note.querySelector("code")?.textContent).toBe("RUNS_READ_FAILED @ RUNS_READ");
  });
});
