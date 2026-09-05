import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { CriterionEvidenceRead } from "../criterion-evidence/criterion-contracts.js";
import type { RepositoryRecoveryView } from "../repository/repository-recovery-contracts.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";
export const CRITERIA_READ_PATH = "/criteria/read" as const;
export const REPOSITORY_RECOVERY_READ_PATH = "/repository/recovery/read" as const;
export interface RepositoryWorkflowReadPort {
  readonly boundProjectId: string;
  readCriteria(goalRef: string): CriterionEvidenceRead;
  readRecovery(): RepositoryRecoveryView;
}
type Workflow = "CRITERIA" | "RECOVERY";
type Refusal = { readonly outcome: "REFUSED"; readonly code: string; readonly layer: string };
export type RepositoryWorkflowReadDispatch =
  | { readonly kind: "REPLY"; readonly httpStatus: number; readonly body: CriterionEvidenceRead | RepositoryRecoveryView | Refusal | HttpPortRefused | HttpRefused }
  | { readonly kind: "LISTENER_REFUSAL"; readonly code: "LISTENER_CRITERIA_REQUEST_INVALID" | "LISTENER_CRITERIA_UNAVAILABLE" | "LISTENER_REPOSITORY_RECOVERY_REQUEST_INVALID" | "LISTENER_REPOSITORY_RECOVERY_UNAVAILABLE" };
const refused = (code: string): RepositoryWorkflowReadDispatch => ({ kind: "REPLY", httpStatus: 200,
  body: { outcome: "REFUSED", code, layer: "REPOSITORY_WORKFLOW_READ" } });
export function handleRepositoryWorkflowReadRequest(workflow: Workflow,
  dependencies: { readonly authenticator: Authenticator; readonly repositoryWorkflows?: RepositoryWorkflowReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): RepositoryWorkflowReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return { kind: "REPLY", httpStatus: access.httpStatus, body: access };
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) return refused("REPOSITORY_WORKFLOW_READ_CAPABILITY_DENIED");
  const port = dependencies.repositoryWorkflows;
  if (port === undefined) return { kind: "LISTENER_REFUSAL", code: workflow === "CRITERIA" ? "LISTENER_CRITERIA_UNAVAILABLE" : "LISTENER_REPOSITORY_RECOVERY_UNAVAILABLE" };
  if (access.principal.projectId !== port.boundProjectId) return refused("REPOSITORY_WORKFLOW_READ_PROJECT_MISMATCH");
  const decoded = decodeBoundedJsonBytes(request.body); const value = decoded.ok ? decoded.value : null;
  const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
  const valid = object !== null && (workflow === "RECOVERY" ? Object.keys(object).length === 0
    : Object.keys(object).length === 1 && typeof object["goalRef"] === "string" && object["goalRef"].length > 0
      && object["goalRef"].length <= 4096 && object["goalRef"].normalize("NFC") === object["goalRef"] && !object["goalRef"].includes("\0"));
  if (!valid) return { kind: "LISTENER_REFUSAL", code: workflow === "CRITERIA" ? "LISTENER_CRITERIA_REQUEST_INVALID" : "LISTENER_REPOSITORY_RECOVERY_REQUEST_INVALID" };
  try { return { kind: "REPLY", httpStatus: 200, body: workflow === "RECOVERY" ? port.readRecovery() : port.readCriteria(object!["goalRef"] as string) }; }
  catch { return refused("REPOSITORY_WORKFLOW_READ_UNREADABLE"); }
}
