import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { OutcomeNote, RefusalNote } from "./outcome-note.js";
import { refusalProvenance, refusalWords } from "./refusal-words.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("refusalWords", () => {
  it("leads with a person's sentence and never puts the code in that sentence", () => {
    expect(refusalWords({ code: "RUNS_READ_FAILED", layer: "RUNS_READ" }))
      .toBe("The nodes could not be read");
    expect(refusalWords({ code: "RUNS_READ_FAILED", layer: "RUNS_READ" }))
      .not.toContain("RUNS_READ_FAILED");
    expect(refusalProvenance({ code: "RUNS_READ_FAILED", layer: "RUNS_READ" }))
      .toBe("RUNS_READ_FAILED @ RUNS_READ");
  });

  it("does not guess a sentence for a code it does not know", () => {
    expect(refusalWords({ code: "NEW_CODE", layer: "CONTROL_ROOM_X" }))
      .toBe("Not available from this page yet");
    expect(refusalWords({ code: "NEW_CODE", layer: "SOME_LAYER", status: "ERROR" }))
      .toBe("This did not complete");
    expect(refusalWords({ code: "NEW_CODE", layer: "SOME_LAYER" }))
      .toBe("The daemon refused this");
  });
});

describe("OutcomeNote", () => {
  it("shows the sentence and keeps the code behind Details", () => {
    render(<OutcomeNote code="RUNS_READ_FAILED" layer="RUNS_READ" said="The nodes could not be read" testId="cr.note" />);
    const note = screen.getByTestId("cr.note");
    expect(note.querySelector(".cr2-outcome-said")?.textContent).toBe("The nodes could not be read");
    expect(note.querySelector("summary")?.textContent).toBe("Details");
    expect(note.querySelector("code")?.textContent).toBe("RUNS_READ_FAILED @ RUNS_READ");
  });

  it("RefusalNote uses the table sentence unless overridden", () => {
    render(<RefusalNote refusal={{ code: "GATE1_READ_FAILED", layer: "CONTROL_ROOM_GATE1" }} testId="cr.note" />);
    expect(screen.getByTestId("cr.note").textContent).toContain("The Product Contract could not be read");
    expect(screen.getByTestId("cr.note").textContent).toContain("GATE1_READ_FAILED @ CONTROL_ROOM_GATE1");
  });
});
