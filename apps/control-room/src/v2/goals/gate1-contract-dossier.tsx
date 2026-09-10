import type { ProductContractRevisionV2, ProductContractV2Requirement } from "@moe/core";
import type { JSX, ReactNode } from "react";

import { MIDDOT } from "../glyphs.js";

interface DossierItem {
  readonly details?: readonly string[];
  readonly id: string;
  readonly statement: string;
}

function joined(label: string, values: readonly string[]): string {
  return values.length === 0 ? `${label} none` : `${label} ${values.join(", ")}`;
}

function DossierSection({
  children,
  items,
  sectionId,
  title,
}: {
  readonly children?: ReactNode;
  readonly items?: readonly DossierItem[];
  readonly sectionId: string;
  readonly title: string;
}): JSX.Element {
  return (
    <section className="cr2-approve-block" data-testid={`cr.gate1.contract.${sectionId}`}>
      <h3 className="cr2-approve-heading">
        {`${title} ${MIDDOT} ${items === undefined ? "REVISION LEDGER" : items.length}`}
      </h3>
      {items === undefined ? children : items.length === 0 ? (
        <p className="cr2-approve-note">None recorded in this revision.</p>
      ) : (
        <ul className="cr2-approve-obligations">
          {items.map((item) => (
            <li className="cr2-approve-obligation" key={item.id}>
              <span className="cr2-approve-mono">{item.id}</span>
              <span className="cr2-approve-step-body">{item.statement}</span>
              {item.details?.map((detail) => (
                <span className="cr2-approve-evidence" key={detail}>{detail}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function requirements(
  sectionId: string,
  title: string,
  rows: readonly ProductContractV2Requirement[],
): JSX.Element {
  return (
    <DossierSection
      items={rows.map((row) => ({
        details: [
          `priority ${row.priority}`,
          joined("depends on", row.dependsOnRequirementIds),
          row.supersedesRequirementId === null
            ? "supersedes none"
            : `supersedes ${row.supersedesRequirementId}`,
        ],
        id: row.requirementId,
        statement: row.statement,
      }))}
      sectionId={sectionId}
      title={title}
    />
  );
}

function Provenance({ revision }: { readonly revision: ProductContractRevisionV2 }): JSX.Element {
  return (
    <DossierSection sectionId="provenance" title="PROVENANCE">
      <dl className="cr2-approve-hashes">
        <dt>author</dt><dd className="cr2-approve-mono">{revision.authorRef}</dd>
        <dt>version</dt><dd className="cr2-approve-mono">{revision.version}</dd>
        <dt>contract</dt><dd className="cr2-approve-mono">{revision.contractId}</dd>
        <dt>revision</dt><dd className="cr2-approve-mono">{revision.revisionId}</dd>
        <dt>digest</dt><dd className="cr2-approve-mono">{revision.revisionDigest}</dd>
        <dt>advisory</dt><dd className="cr2-approve-mono">{String(revision.advisoryOnly)}</dd>
        <dt>source documents</dt>
        <dd className="cr2-approve-mono">{revision.sourceDocumentDigests.join(", ")}</dd>
        <dt>parent revision</dt>
        <dd className="cr2-approve-mono">
          {revision.lineage === null ? "GENESIS" : revision.lineage.parentRevisionId}
        </dd>
        <dt>parent digest</dt>
        <dd className="cr2-approve-mono">
          {revision.lineage === null ? "GENESIS" : revision.lineage.parentRevisionDigest}
        </dd>
      </dl>
    </DossierSection>
  );
}

export function Gate1ContractDossier({
  revision,
}: { readonly revision: ProductContractRevisionV2 }): JSX.Element {
  return (
    <div className="cr2-approve-body" data-testid="cr.gate1.pending">
      <DossierSection
        items={revision.objectives.map((row) => ({
          id: row.objectiveId, statement: row.statement,
        }))}
        sectionId="objectives"
        title="OBJECTIVES"
      />
      <DossierSection
        items={revision.userJobs.map((row) => ({
          details: [`user ${row.user}`], id: row.userJobId, statement: row.job,
        }))}
        sectionId="user-jobs"
        title="USER JOBS"
      />
      <DossierSection
        items={revision.journeys.map((row) => ({
          details: [`user job ${row.userJobId}`, joined("criteria", row.criterionIds)],
          id: row.journeyId,
          statement: row.statement,
        }))}
        sectionId="journeys"
        title="JOURNEYS"
      />
      {requirements("requirements.functional", "FUNCTIONAL REQUIREMENTS", revision.functionalRequirements)}
      {requirements(
        "requirements.non-functional", "NON-FUNCTIONAL REQUIREMENTS",
        revision.nonFunctionalRequirements,
      )}
      {requirements(
        "requirements.security-privacy", "SECURITY + PRIVACY REQUIREMENTS",
        revision.securityPrivacyRequirements,
      )}
      {requirements(
        "requirements.technology", "TECHNOLOGY REQUIREMENTS", revision.technologyRequirements,
      )}
      {requirements(
        "requirements.ux-accessibility", "UX + ACCESSIBILITY REQUIREMENTS",
        revision.uxAccessibilityRequirements,
      )}
      {requirements(
        "requirements.deployment", "DEPLOYMENT REQUIREMENTS", revision.deploymentRequirements,
      )}
      <DossierSection
        items={revision.criteria.map((row) => ({
          details: [
            `requirement ${row.requirementId}`,
            `verification ${row.verification}`,
            row.supersedesCriterionId === null
              ? "supersedes none"
              : `supersedes ${row.supersedesCriterionId}`,
          ],
          id: row.criterionId,
          statement: row.statement,
        }))}
        sectionId="criteria"
        title="ACCEPTANCE CRITERIA"
      />
      <DossierSection
        items={revision.negativeScope.map((row) => ({
          id: row.scopeId, statement: row.statement,
        }))}
        sectionId="negative-scope"
        title="NEGATIVE SCOPE"
      />
      <DossierSection
        items={revision.assumptions.map((row) => ({
          details: [`validated by ${row.validationCriterionId}`],
          id: row.assumptionId,
          statement: row.statement,
        }))}
        sectionId="assumptions"
        title="ASSUMPTIONS"
      />
      <DossierSection
        items={revision.budgets.map((row) => ({
          details: [`kind ${row.kind}`],
          id: row.budgetId,
          statement: `${String(row.limit)} ${row.unit}`,
        }))}
        sectionId="budgets"
        title="BUDGETS"
      />
      <DossierSection
        items={revision.successMetrics.map((row) => ({
          details: [
            `target ${row.target}`,
            `measurement ${row.measurement}`,
            joined("objectives", row.objectiveIds),
          ],
          id: row.metricId,
          statement: row.statement,
        }))}
        sectionId="success-metrics"
        title="SUCCESS METRICS"
      />
      <DossierSection
        items={revision.materialDecisions.map((row) => ({
          details: [
            row.selectedOptionId === null
              ? "selected option unresolved"
              : `selected option ${row.selectedOptionId}`,
            ...row.options.map((option) => `${option.optionId}: ${option.statement}`),
          ],
          id: row.decisionId,
          statement: row.question,
        }))}
        sectionId="material-decisions"
        title="MATERIAL DECISIONS"
      />
      <DossierSection
        items={[{
          details: [joined("criteria", revision.productCompleteDefinition.criterionIds)],
          id: "product-complete-definition",
          statement: revision.productCompleteDefinition.statement,
        }]}
        sectionId="product-complete"
        title="PRODUCT COMPLETE"
      />
      <Provenance revision={revision} />
      <DossierSection
        items={[
          {
            id: "retired-requirements",
            statement: joined("requirement IDs", revision.retiredRequirementIds),
          },
          {
            id: "retired-criteria",
            statement: joined("criterion IDs", revision.retiredCriterionIds),
          },
        ]}
        sectionId="retired"
        title="RETIRED IDENTIFIERS"
      />
    </div>
  );
}
