import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createProductContractRevisionV2 } from "@moe/core";
import type { ProductContractRevisionV2 } from "@moe/core";

import type { EnvironmentVariableRead } from "./environment-contracts.js";
import {
  requiredVariableNames,
  unsetVariableNames,
} from "./environment-required-variables.js";

/**
 * DERIVED off the revision rather than imported by name: `ProductContractV2DeploymentRequirement`
 * is declared in `@moe/core` but is NOT re-exported from its barrel, so naming it directly is a
 * TS2724. Reading the element type off `deploymentRequirements` is also the stricter pin - a
 * fixture built this way is exactly what the revision holds, and cannot drift from it.
 */
type DeploymentRequirement = ProductContractRevisionV2["deploymentRequirements"][number];

/**
 * A deployment requirement, optionally naming the variables it needs. `environmentVariableNames`
 * is ABSENT rather than `[]` when no names are given: admission's `exact` key check treats the
 * key's presence as the discriminator between the two deployment-requirement shapes, so an
 * explicit `undefined` would not round-trip.
 */
const deployment = (
  requirementId: string,
  environmentVariableNames?: readonly string[],
): DeploymentRequirement => ({
  dependsOnRequirementIds: [],
  ...(environmentVariableNames === undefined ? {} : { environmentVariableNames }),
  priority: "MUST",
  requirementId,
  statement: `the product is deployable: ${requirementId}`,
  supersedesRequirementId: null,
});

const plain = (requirementId: string) => ({
  dependsOnRequirementIds: [],
  priority: "MUST" as const,
  requirementId,
  statement: `the product satisfies ${requirementId}`,
  supersedesRequirementId: null,
});

const criterion = (criterionId: string, requirementId: string) => ({
  criterionId,
  requirementId,
  statement: `${requirementId} is observed`,
  supersedesCriterionId: null,
  verification: `assert ${requirementId}`,
});

/**
 * Every non-deployment section must be NON-EMPTY: `readSortedItems` is called with
 * `allowEmpty: false` for all six requirement sections, so a fixture that leaves one out is
 * refused with `PRODUCT_CONTRACT_V2_PROVENANCE_INVALID` rather than admitted. And EVERY
 * requirement needs a criterion, or admission answers `PRODUCT_CONTRACT_V2_COVERAGE_INCOMPLETE` -
 * which is why the deployment criteria below are derived from the requirements passed in rather
 * than listed as a constant.
 */
const FIXED_CRITERIA = Object.freeze([
  ["criterion-keyboard", "ux-keyboard"],
  ["criterion-latency", "nfr-latency"],
  ["criterion-login", "requirement-login"],
  ["criterion-runtime", "technology-runtime"],
  ["criterion-session", "security-session"],
] as const);

/** A BARE hex sha256 - the contract's digest grammar carries no `sha256:` prefix. */
const digest = (label: string): string => createHash("sha256").update(label).digest("hex");

const sorted = (values: readonly string[]): string[] =>
  [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

/**
 * A REAL approved revision, minted through the production admission path rather than cast into
 * shape. `createProductContractRevisionV2` refuses anything the contract would refuse, so a
 * fixture that mints proves the names it carries are names a real contract could hold.
 */
function revision(
  deploymentRequirements: readonly DeploymentRequirement[],
): ProductContractRevisionV2 {
  const pairs = [
    ...FIXED_CRITERIA.map(([criterionId, requirementId]) => [criterionId, requirementId] as const),
    ...deploymentRequirements.map((item) =>
      [`criterion-${item.requirementId}`, item.requirementId] as const),
  ];
  const criterionIds = sorted(pairs.map(([criterionId]) => criterionId));
  const result = createProductContractRevisionV2({
    assumptions: [],
    authorRef: "principal-product",
    budgets: [{ budgetId: "budget-build", kind: "TIME", limit: 30, unit: "days" }],
    contractId: "contract-env",
    criteria: criterionIds.map((criterionId) =>
      criterion(criterionId, pairs.find(([id]) => id === criterionId)![1])),
    deploymentRequirements,
    functionalRequirements: [plain("requirement-login")],
    journeys: [{
      criterionIds: ["criterion-login"], journeyId: "journey-login",
      statement: "An operator signs in.", userJobId: "job-access",
    }],
    lineage: null,
    materialDecisions: [],
    negativeScope: [{ scopeId: "scope-native", statement: "No native mobile client." }],
    nonFunctionalRequirements: [plain("nfr-latency")],
    objectives: [{ objectiveId: "objective-adoption", statement: "Enable first-use success." }],
    productCompleteDefinition: {
      criterionIds, statement: "Every criterion is independently verified.",
    },
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "contract-env-r1",
    securityPrivacyRequirements: [plain("security-session")],
    sourceDocumentDigests: [digest("source-document")],
    successMetrics: [{
      measurement: "Count successful first sessions.", metricId: "metric-first-use",
      objectiveIds: ["objective-adoption"], statement: "Operators complete a first session.",
      target: "At least ten successful sessions.",
    }],
    technologyRequirements: [plain("technology-runtime")],
    userJobs: [{ job: "Reach the product.", user: "Operator", userJobId: "job-access" }],
    uxAccessibilityRequirements: [plain("ux-keyboard")],
  });
  if (!result.ok) throw new Error(`the fixture is not an admissible contract: ${result.code}`);
  return result.revision;
}

/** What the store reports for a variable that IS set. No value, by construction. */
const setVariable = (name: string): EnvironmentVariableRead => ({
  fingerprintSha256: "b".repeat(64),
  isSet: true,
  name,
  updatedAt: "2026-09-06T00:00:00.000Z",
});

describe("the required variable names of an approved contract", () => {
  it("reads the names off the contract's deployment requirements", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL", "SESSION_KEY"])]);

    expect(requiredVariableNames(contract)).toEqual(["DATABASE_URL", "SESSION_KEY"]);
  });

  it("yields an empty set for a contract whose requirements name nothing, without throwing", () => {
    const contract = revision([deployment("deployment-runtime")]);

    expect(requiredVariableNames(contract)).toEqual([]);
    expect(unsetVariableNames(requiredVariableNames(contract), [])).toEqual([]);
  });

  it("does not collect names a NON-deployment requirement carries", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL"])]);
    // Admission REFUSES this object: the five non-deployment sections still use the unwidened
    // `requirement` validator, whose `exact` key check rejects the extra carrier. It is grafted
    // structurally so the read is exercised against a shape admission would never hand it -
    // this arm pins the read's SCOPE, so a later widening of the shared validator, or a read
    // rerouted through a section-flattening helper, goes red here rather than silently
    // publishing a technology requirement's names into `.env.example`.
    const widened = {
      ...contract,
      technologyRequirements: [
        { ...plain("technology-runtime"), environmentVariableNames: ["TECHNOLOGY_ONLY"] },
      ],
    } as unknown as ProductContractRevisionV2;

    const required = requiredVariableNames(widened);

    expect(required).toEqual(["DATABASE_URL"]);
    expect(required).not.toContain("TECHNOLOGY_ONLY");
  });

  it("dedupes and sorts names two deployment requirements both name", () => {
    const contract = revision([
      deployment("deployment-loopback", ["SESSION_KEY"]),
      deployment("deployment-runtime", ["DATABASE_URL", "SESSION_KEY"]),
    ]);

    expect(requiredVariableNames(contract)).toEqual(["DATABASE_URL", "SESSION_KEY"]);
  });

  it("drops a name the contract grammar could not have admitted", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL"])]);
    // Only reachable by bypassing admission. These bytes are interpolated into a file that is
    // committed and pushed, so a name carrying a newline or an `=` could inject a line - and a
    // line is where a VALUE would come from. Dropped rather than surfaced.
    const forged = {
      ...contract,
      deploymentRequirements: [{
        ...plain("deployment-runtime"),
        environmentVariableNames: ["DATABASE_URL", "OK\nSMUGGLED=secret", "lower", "HAS=EQUALS"],
      }],
    } as unknown as ProductContractRevisionV2;

    expect(requiredVariableNames(forged)).toEqual(["DATABASE_URL"]);
  });

  it("keeps a leading-underscore name, which the contract admits and the store cannot hold", () => {
    // The two grammars disagree: the contract admits /^[A-Z_][A-Z0-9_]*$/ while the environment
    // store's `isEnvironmentVariableName` requires /^[A-Z][A-Z0-9_]*$/. Filtering with the
    // STORE's narrower pattern would make a required variable vanish from the report and from
    // `.env.example`, so the operator would never learn it was required. It is reported, and it
    // reports as permanently unset - which is the truth.
    const contract = revision([deployment("deployment-runtime", ["_INTERNAL_TOKEN"])]);

    expect(requiredVariableNames(contract)).toEqual(["_INTERNAL_TOKEN"]);
  });
});

describe("the unset variable report for an environment", () => {
  it("reports exactly the required names the environment does not hold", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL", "SESSION_KEY"])]);
    const required = requiredVariableNames(contract);

    const unset = unsetVariableNames(required, [setVariable("SESSION_KEY")]);

    // Set equality, not toContain: a report that echoed the requirement list would pass a
    // containment check while telling the operator to set a variable they already set.
    expect([...unset].sort()).toEqual(["DATABASE_URL"]);
    expect(unset).not.toContain("SESSION_KEY");
  });

  it("reports every required name when the environment holds nothing", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL", "SESSION_KEY"])]);

    expect(unsetVariableNames(requiredVariableNames(contract), []))
      .toEqual(["DATABASE_URL", "SESSION_KEY"]);
  });

  it("ignores a set variable the contract does not require", () => {
    const contract = revision([deployment("deployment-runtime", ["DATABASE_URL"])]);

    const unset = unsetVariableNames(
      requiredVariableNames(contract),
      [setVariable("LEFTOVER"), setVariable("DATABASE_URL")],
    );

    expect(unset).toEqual([]);
  });

  it("returns a sorted, deduped report regardless of the order it is given", () => {
    expect(unsetVariableNames(["SESSION_KEY", "DATABASE_URL", "SESSION_KEY"], []))
      .toEqual(["DATABASE_URL", "SESSION_KEY"]);
  });
});
