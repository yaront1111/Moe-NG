import { createProductContractRevisionV2 } from "@moe/core";
import type { ProductContractRevisionV2 } from "@moe/core";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Gate1ContractDossier } from "./gate1-contract-dossier.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

/**
 * Six identifier families of 25 functional requirements, each with one criterion: 150 + 150
 * = 300 statements of ~400 characters, ADMITTED BY PRODUCTION CORE so the revision is one
 * the daemon could publish. The V2 card mounts this dossier once cutover.activate commits;
 * the same 278-row first paint that stalled the V1 card would return there otherwise.
 */
const FAMILIES = ["AI", "CON", "DATA", "OPS", "SEC", "UX"] as const;
const PER_FAMILY = 25;
const FILLER = "the daemon records the decision and the board shows it ".repeat(7).trim();

function statement(kind: string, family: string, index: number): string {
  return `${kind} ${family} ${String(index)}: ${FILLER}`;
}

/** One requirement for a non-functional section, covered by one criterion. */
function oneRequirement(requirementId: string) {
  return {
    dependsOnRequirementIds: [], priority: "MUST" as const, requirementId,
    statement: `${requirementId} must hold.`, supersedesRequirementId: null,
  };
}
function oneCriterion(criterionId: string, requirementId: string) {
  return {
    criterionId, requirementId, statement: `${criterionId} is observable.`,
    supersedesCriterionId: null, verification: `Verify ${criterionId} deterministically.`,
  };
}

function largeRevision(): ProductContractRevisionV2 {
  const numbered = (index: number): string => String(index + 1).padStart(3, "0");
  const pairs = FAMILIES.flatMap((family) => Array.from({ length: PER_FAMILY }, (_, index) => ({
    criterionId: `CRT-${family}-${numbered(index)}`,
    family,
    index: index + 1,
    requirementId: `REQ-${family}-${numbered(index)}`,
  })));
  // Every section the admission requires non-empty holds one row; identifiers sort
  // ascending as the admission demands (upper-case CRT-* before lower-case criterion-*).
  const singles = ["deployment", "nfr", "security", "technology", "ux"] as const;
  const criteria = [
    ...pairs.map((pair) => ({
      ...oneCriterion(pair.criterionId, pair.requirementId),
      statement: statement("Criterion", pair.family, pair.index),
    })),
    ...singles.map((name) => oneCriterion(`criterion-${name}`, `requirement-${name}`)),
  ];
  const created = createProductContractRevisionV2({
    assumptions: [],
    authorRef: "principal-product",
    budgets: [{ budgetId: "budget-delivery", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-large",
    criteria,
    deploymentRequirements: [oneRequirement("requirement-deployment")],
    functionalRequirements: pairs.map((pair) => ({
      dependsOnRequirementIds: [],
      priority: "MUST" as const,
      requirementId: pair.requirementId,
      statement: statement("Requirement", pair.family, pair.index),
      supersedesRequirementId: null,
    })),
    journeys: [{
      criterionIds: ["CRT-AI-001"], journeyId: "journey-access",
      statement: "A registered operator signs in and reaches the product.", userJobId: "job-access",
    }],
    lineage: null,
    materialDecisions: [],
    negativeScope: [{ scopeId: "scope-native", statement: "No native mobile client." }],
    nonFunctionalRequirements: [oneRequirement("requirement-nfr")],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first-use success." }],
    productCompleteDefinition: {
      criterionIds: criteria.map((row) => row.criterionId),
      statement: "Every criterion is independently verified.",
    },
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "revision-large",
    securityPrivacyRequirements: [oneRequirement("requirement-security")],
    sourceDocumentDigests: ["a".repeat(64)],
    successMetrics: [{
      measurement: "Count consented successful first sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Operators complete their first session.",
      target: "At least 80 percent in a cohort of at least ten.",
    }],
    technologyRequirements: [oneRequirement("requirement-technology")],
    userJobs: [{
      job: "Reach the product with my registered identity.", user: "Registered operator",
      userJobId: "job-access",
    }],
    uxAccessibilityRequirements: [oneRequirement("requirement-ux")],
  });
  if (!created.ok) throw new Error(`large revision refused: ${created.code}@${created.layer}`);
  return created.revision;
}

describe("the V2 Gate 1 dossier with a 300-statement revision", () => {
  it("mounts the section counts and six closed families per roster - none of the 300 rows", () => {
    render(<Gate1ContractDossier revision={largeRevision()} />);
    expect(screen.getByTestId("cr.gate1.contract.requirements.functional").textContent)
      .toContain("FUNCTIONAL REQUIREMENTS · 150");
    expect(screen.getByTestId("cr.gate1.contract.criteria").textContent)
      .toContain("ACCEPTANCE CRITERIA · 155");

    const requirementFamilies = screen.getAllByTestId(/^cr\.gate1\.contract\.requirements\.functional\.group\./u);
    const criterionFamilies = screen.getAllByTestId(/^cr\.gate1\.contract\.criteria\.group\./u);
    expect(requirementFamilies.map((toggle) => toggle.textContent))
      .toEqual(FAMILIES.map((family) => `REQ-${family}· 25`));
    // The five `criterion-<section>` ids share the family `criterion`, one group after the six.
    expect(criterionFamilies.map((toggle) => toggle.textContent))
      .toEqual([...FAMILIES.map((family) => `CRT-${family}· 25`), "criterion· 5"]);
    for (const toggle of [...requirementFamilies, ...criterionFamilies]) {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    }
    // The load-bearing count: 0 of the 150 requirement rows and 0 of the 155 criterion rows.
    expect(screen.queryAllByTestId(/^cr\.gate1\.contract\.requirements\.functional\.row\./u)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^cr\.gate1\.contract\.criteria\.row\./u)).toHaveLength(0);
    expect(screen.queryByText(statement("Requirement", "AI", 1))).toBeNull();
    // The two-row sections stay flat and readable without a click.
    expect(screen.getByTestId("cr.gate1.contract.retired.row.retired-requirements").textContent)
      .toContain("requirement IDs none");
  });

  it("opens one family on click and shows its 25 statements with their details", async () => {
    const user = userEvent.setup();
    render(<Gate1ContractDossier revision={largeRevision()} />);
    await user.click(screen.getByTestId("cr.gate1.contract.criteria.group.CRT-CON"));
    const shown = screen.getAllByTestId(/^cr\.gate1\.contract\.criteria\.row\./u);
    expect(shown).toHaveLength(PER_FAMILY);
    expect(shown.every((row) => row.getAttribute("data-testid")?.startsWith("cr.gate1.contract.criteria.row.CRT-CON-")))
      .toBe(true);
    const row = screen.getByTestId("cr.gate1.contract.criteria.row.CRT-CON-007").textContent ?? "";
    expect(row).toContain(statement("Criterion", "CON", 7));
    expect(row).toContain("requirement REQ-CON-007");
    expect(row).toContain("verification Verify CRT-CON-007 deterministically.");
    // The requirement roster and the other criterion families stay closed.
    expect(screen.queryAllByTestId(/^cr\.gate1\.contract\.requirements\.functional\.row\./u)).toHaveLength(0);
    expect(screen.getByTestId("cr.gate1.contract.criteria.group.CRT-AI").getAttribute("aria-expanded"))
      .toBe("false");
  });
});
