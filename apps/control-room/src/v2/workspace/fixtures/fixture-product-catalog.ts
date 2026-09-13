import type { GoalsData } from "../../goals/goal-model.js";

/** One coherent example journey, admitted only by the development fixture entry. */
export const PRODUCT_EXAMPLE_DATA: GoalsData = {
  source: "fixtures",
  goalCountLabel: "1 example product",
  triage: [],
  goals: [{
    goalId: "goal-j1",
    title: "Bicycle shop appointments",
    titleIsIdentifier: false,
    state: "DRAFT",
    needsYou: false,
    headline: "Example product. Help customers request a bicycle repair appointment.",
    headlineTone: "accent",
    lastEventLabel: "Interactive example",
    progressNote: "Example artifact states do not report live work.",
    headlineFacts: [],
    facts: [
      { factId: "example.includes", label: "Example artifacts", value: "Requirements, authored design and candidate text" },
      { factId: "example.preview", label: "Captured preview", value: "Not available in this example" },
    ],
    comingOnlineFacts: [],
  }],
};
