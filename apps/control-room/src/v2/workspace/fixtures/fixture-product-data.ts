import { buildProductRequirements, selectProductArtifact } from "@moe/control-room-model";
import type { ProductArtifact, ProductCheck, ProductContractRef, ProductRequirement, ProductScope } from "@moe/control-room-model";
import type { GoalSourceOutcome } from "../../../live/live-goal-source.js";
import type { DesignOutcome } from "../../../live/live-design.js";
import type { ReleaseOutcome } from "../../../live/live-release.js";
import type { ProductWorkspaceModel } from "../product-model-contracts.js";

/** Authored examples only. None of these references identifies a live project or command. */
export const EXAMPLE_TITLE = "Bicycle shop appointments";
const approved: ProductContractRef = { plane: "V1", contractId: "example:contract", revisionId: "appointments", revisionDigest: "example:appointments" };
const proposed: ProductContractRef = { ...approved, revisionId: "proposed-payments", revisionDigest: "example:payments" };
const FAILED_SHA = "example:candidate:date-defect";
const CORRECTED_SHA = "example:candidate:date-corrected";
const GRAPH = "example:appointment-graph";
const PRD = `# Bicycle shop appointments

Customers request a bicycle repair appointment. The shop confirms a suitable time.

The customer supplies a name, email address, preferred date and a description of the repair.
Keep the selected calendar date unchanged, including requests made near midnight.

The shop sees pending requests and sends a confirmation when it accepts one.
Online payment is excluded from this first release.

The form must work with a keyboard and show a clear confirmation after submission.`;

export const EXAMPLE_SOURCE: GoalSourceOutcome = Object.freeze({ status: "GOAL_SOURCE", text: PRD,
  sourceRef: "example:source", displayPath: "Appointment product requirements",
  contentSha256: "ce43c9652f0693a28f749c25497cf61b991573c210fb24ad07e25d28ac7475b4",
  byteLength: new TextEncoder().encode(PRD).byteLength, mediaType: "text/markdown" });

const requirements: readonly ProductRequirement[] = [
  { requirementId: "example:request", statement: "Customers can request an appointment", criteria: [
    { criterionId: "example:submit", statement: "A submitted request reaches the shop" },
  ] },
  { requirementId: "example:date", statement: "Appointment dates stay on the chosen day", criteria: [
    { criterionId: "example:date", statement: "The request date is unchanged near midnight" },
  ] },
];
const payment: ProductRequirement = { requirementId: "example:payment", statement: "Customers can pay online", criteria: [
  { criterionId: "example:payment", statement: "A customer can pay for an accepted booking" },
] };

export function exampleDesign(goalId: string): DesignOutcome {
  return { status: "DESIGN", versions: [1], record: { contractRef: approved, goalRef: goalId,
    profile: "web", projectId: "example:project", schemaVersion: "example:design", version: 1,
    submittedAt: "2026-09-13T00:00:00Z", revision: {
      screens: [{ journey: "Request an appointment", screens: [
        { screen: "Repair request", states: ["Your name and email", "Preferred repair date", "Describe the repair", "Request received"] },
        { screen: "Shop inbox", states: ["Pending requests", "Confirm a time", "Confirmation sent"] },
      ] }],
      componentList: ["Appointment request form", "Shop request list", "Confirmation message"],
      dataModel: [{ entity: "Appointment request", fields: ["Customer contact", "Local calendar date", "Repair description", "Status"], relations: [] }],
      apiSurface: [{ route: "POST /appointments", payload: "Customer contact, chosen local date and repair description" }],
      nonFunctional: { accessibility: "Labels, keyboard navigation and explicit error messages",
        auth: "Customers request appointments; only shop staff confirm them", performance: "A clear submission outcome without losing entered details" },
      openDecisions: ["Online payment remains excluded from the approved appointment scope"],
    } } };
}

export function exampleRelease(goalId: string): ReleaseOutcome {
  return { status: "PRESENT", evidence: { goalId, goalTitle: EXAMPLE_TITLE, ancestryMeasured: true,
    criteria: [], preview: null, reviewRounds: [], sha: CORRECTED_SHA,
    receipt: { dossierSha256: "example:dossier", outcome: "RELEASED", prUrl: null,
      receiptId: "example:release", refusalCode: null, sha: CORRECTED_SHA },
  } };
}

export function createFixtureProductModel(goalId: string, selectedId: string | null): ProductWorkspaceModel {
  const scope: ProductScope = { connectionId: "example:connection", projectId: "example:project", goalId, plane: "V1" };
  const artifact = (id: string, kind: ProductArtifact["kind"], title: string,
    patch: Partial<ProductArtifact> = {}): ProductArtifact => Object.freeze({ id, kind, title, scope,
    contractRef: approved, planningRunRef: null, sha: null, availability: "PRESENT", ...patch });
  const failed = artifact("example:build:failed", "BUILD", "Candidate with date defect", { planningRunRef: "example:run", sha: FAILED_SHA });
  const corrected = artifact("example:build:corrected", "BUILD", "Corrected appointment candidate", { planningRunRef: "example:run", sha: CORRECTED_SHA });
  const released = artifact("example:release", "RELEASE", "Released appointment source", { planningRunRef: "example:run", sha: CORRECTED_SHA });
  const artifacts = Object.freeze([
    artifact("example:source", "SOURCE", "Original appointment PRD"),
    artifact("example:definition", "DEFINITION", "Approved appointment definition"),
    artifact("example:design", "DESIGN", "Authored appointment design"), failed, corrected,
    artifact("example:preview", "PREVIEW", "Captured preview unavailable", { availability: "UNREADABLE", sha: CORRECTED_SHA }),
    released, artifact("example:scope", "DEFINITION", "Proposed payment scope", { contractRef: proposed }),
  ]);
  const selection = selectProductArtifact({ scope, artifacts, selectedId, preferredId: "example:source" });
  const isProposal = selection.artifact?.contractRef?.revisionId === proposed.revisionId;
  const contractRef = selection.artifact?.contractRef ?? null;
  const checks: ProductCheck[] = [FAILED_SHA, CORRECTED_SHA].flatMap((sha, index) => requirements.map((row) => ({
    scope, contractRef: approved, planningRunRef: "example:run", graphContentHash: GRAPH, criterionId: row.criteria[0]!.criterionId, sha,
    receiptId: `example:check:${index === 0 ? "failed" : "corrected"}:${row.requirementId.split(":")[1]}`,
    status: index === 0 && row.requirementId === "example:date" ? "FAILED" : "PASSED",
  })));
  const result = buildProductRequirements({ scope, contractRef, planningRunRef: selection.artifact?.planningRunRef ?? null,
    graphContentHash: GRAPH, sha: selection.artifact?.sha ?? null,
    availability: selection.status === "UNAVAILABLE" ? "UNREADABLE" : "PRESENT",
    requirements: isProposal ? [...requirements, payment] : requirements,
    implementationLinks: requirements.map((row) => ({ scope, contractRef: approved, planningRunRef: "example:run",
      graphContentHash: GRAPH, criterionId: row.criteria[0]!.criterionId, nodeKey: `example:work:${row.requirementId}`, state: "IMPLEMENTED" })),
    checks,
  });
  return Object.freeze({ ...result, artifacts, selection, contractRef, currentWork: corrected, delivered: released,
    deliveryState: "PRESENT", deliveryNote: "A released version is available",
    scopeNote: isProposal ? "Payments are a proposed scope change. Appointment checks and the released version remain bound to the approved scope."
      : "Example records for this selected artifact; no design or preview location link is asserted.",
  });
}
