import type { IncomingMessage, ServerResponse } from "node:http";

import { DOCUMENT_DOSSIER_PATH, handleDocumentDossierReadRequest } from "./document-dossier-read.js";
import { DOCUMENT_INGEST_PATH, handleDocumentIngestRequest } from "./document-ingest-route.js";
import { GOAL_CATALOG_READ_PATH, handleGoalCatalogReadRequest } from "./goal-catalog-read.js";
import {
  BUDGET_COMMITMENT_READ_PATH, handleBudgetCommitmentReadRequest,
} from "./budget-commitment-read.js";
import { PLANNING_RUN_READ_PATH, handlePlanningRunReadRequest } from "./planning-run-read.js";
import {
  PRODUCT_CONTRACT_GATE_1_READ_PATH, handleProductContractGate1ReadRequest,
} from "./product-contract-gate-1-read.js";
import {
  PRODUCT_CONTRACT_PENDING_READ_PATH, handleProductContractPendingReadRequest,
} from "./product-contract-pending-read.js";
import {
  PRODUCT_CONTRACT_V2_CURRENT_READ_PATH, handleProductContractV2CurrentReadRequest,
} from "./product-contract-v2-current-read.js";
import {
  PRODUCT_CONTRACT_V2_PENDING_READ_PATH, handleProductContractV2PendingReadRequest,
} from "./product-contract-v2-pending-read.js";
import {
  SESSION_CHALLENGE_OPERANDS_READ_PATH, handleSessionChallengeOperandsReadRequest,
} from "./session-challenge-operands-read.js";
import { DOCUMENT_COVERAGE_READ_PATH } from "./document-coverage-contract.js";
import { handleDocumentCoverageReadRequest } from "./document-coverage-route.js";
import { RUNS_READ_PATH } from "./runs-read-contract.js";
import { handleRunsReadRequest } from "./runs-read-route.js";
import { POLICY_READ_PATH, handlePolicyReadRequest } from "./policy-read.js";
import { ACTIVATION_READ_PATH, handleActivationReadRequest } from "./activation-read.js";
import { HEALTH_READ_PATH, handleHealthReadRequest } from "./health-read.js";
import { ACTIVITY_READ_PATH, handleActivityReadRequest } from "./activity-read.js";
import { SESSIONS_READ_PATH, handleSessionsReadRequest } from "./sessions-read.js";
import { REPOSITORY_REMOTE_READ_PATH, handleRepositoryRemoteReadRequest } from "./repository-remote-read.js";
import { GOAL_SOURCE_READ_PATH, handleGoalSourceReadRequest } from "./goal-source-read.js";
import {
  checkHeaders, credentialOf, protocolVersionOf, readBoundedBody,
} from "./http-listener-guards.js";
import {
  AFFORDANCE_PATH, COMMAND_PATH, EVENT_ACKNOWLEDGE_PATH, EVENT_PAGE_PATH, EVENT_RESUME_PATH,
  GRAPH_GET_PATH, V2_COMMAND_PATH, refuseRequest, reply, serveAffordances, serveCommand,
  serveAsset, serveEventAcknowledge, serveEventPage, serveEventResume, serveGraphQuery,
  serveV2Command,
} from "./http-listener-command-stream-routes.js";
import type { ControlRoomAssetRoot } from "./static-asset-host.js";
// TYPE-ONLY, for the same reason as in `http-listener-command-stream-routes.ts`: a value
// import of a symbol declared in the facade this module is dispatched FROM closes a real
// runtime cycle through the .js bridges, typechecks clean, and can leave a handler
// undefined at bind time.
import type { StartListenerOptions } from "./http-listener.js";

/**
 * THE READ AND ASSET DISPATCH, extracted VERBATIM from `http-listener.ts`.
 *
 * GUARD ORDER IS THE BEHAVIOUR and it is unchanged: JSON_ROUTES membership decides
 * asset-vs-JSON first, the unhosted `assets === null` answer stays the one it always was,
 * `checkHeaders` runs once for the whole JSON surface, then the per-path POST guards in
 * their original order, then the bounded body, then the dispatch chain. That chain's final
 * `else serveDocumentDossier(...)` is the roster's own bidirectional consistency - every
 * JSON_ROUTES member either has an explicit branch or IS the dossier path - so it stays an
 * unconditional else and never becomes a branch with none.
 */

/** The JSON surface. Anything else is either a hosted asset or an unknown route. */
export const JSON_ROUTES: readonly string[] = Object.freeze([
  AFFORDANCE_PATH,
  BUDGET_COMMITMENT_READ_PATH,
  COMMAND_PATH,
  DOCUMENT_COVERAGE_READ_PATH,
  DOCUMENT_DOSSIER_PATH,
  DOCUMENT_INGEST_PATH,
  EVENT_ACKNOWLEDGE_PATH,
  EVENT_PAGE_PATH,
  EVENT_RESUME_PATH,
  GRAPH_GET_PATH,
  GOAL_CATALOG_READ_PATH,
  PLANNING_RUN_READ_PATH,
  PRODUCT_CONTRACT_GATE_1_READ_PATH,
  PRODUCT_CONTRACT_PENDING_READ_PATH,
  PRODUCT_CONTRACT_V2_CURRENT_READ_PATH,
  PRODUCT_CONTRACT_V2_PENDING_READ_PATH,
  SESSION_CHALLENGE_OPERANDS_READ_PATH,
  V2_COMMAND_PATH,
  RUNS_READ_PATH,
  POLICY_READ_PATH,
  ACTIVATION_READ_PATH,
  HEALTH_READ_PATH,
  ACTIVITY_READ_PATH,
  SESSIONS_READ_PATH,
  REPOSITORY_REMOTE_READ_PATH,
  GOAL_SOURCE_READ_PATH,
]);

function serveDocumentDossier(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleDocumentDossierReadRequest({
    authenticator: options.deps.authenticator,
    documentDossiers: options.documentDossiers,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function servePlanningRun(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handlePlanningRunReadRequest({
    authenticator: options.deps.authenticator,
    planningRuns: options.planningRuns,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveGoalCatalog(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleGoalCatalogReadRequest({
    authenticator: options.deps.authenticator,
    goalCatalog: options.goalCatalog,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveBudgetCommitmentRead(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleBudgetCommitmentReadRequest({
    authenticator: options.deps.authenticator,
    budgetCommitment: options.budgetCommitment,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveProductContractGate1(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleProductContractGate1ReadRequest({
    authenticator: options.deps.authenticator,
    productContractGate1: options.productContractGate1,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveProductContractPending(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleProductContractPendingReadRequest({
    authenticator: options.deps.authenticator,
    productContractPending: options.productContractPending,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveProductContractV2Current(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  if (options.v2Deps === undefined) {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_UNAVAILABLE");
    return;
  }
  const result = handleProductContractV2CurrentReadRequest({
    authenticator: options.v2Deps.authenticator,
    ...(options.productContractV2Current === undefined
      ? {} : { productContractV2Current: options.productContractV2Current }),
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveProductContractV2Pending(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions,
  body: Uint8Array,
): void {
  if (options.v2Deps === undefined) {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_V2_PENDING_UNAVAILABLE"); return;
  }
  const result = handleProductContractV2PendingReadRequest({
    authenticator: options.v2Deps.authenticator,
    ...(options.productContractV2Pending === undefined ? {}
      : { productContractV2Pending: options.productContractV2Pending }),
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveSessionChallengeOperands(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleSessionChallengeOperandsReadRequest({
    authenticator: options.deps.authenticator,
    sessionChallengeOperands: options.sessionChallengeOperands,
  }, {
    body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

function serveDocumentCoverage(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleDocumentCoverageReadRequest({
    authenticator: options.deps.authenticator, documentCoverage: options.documentCoverage,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveRuns(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleRunsReadRequest({
    authenticator: options.deps.authenticator, runs: options.runs,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function servePolicy(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handlePolicyReadRequest({
    authenticator: options.deps.authenticator, policy: options.policy,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

/** ASYNC alone among the reads: the activation receipts are measured, not projected. */
async function serveActivation(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): Promise<void> {
  const result = await handleActivationReadRequest({
    activation: options.activation, authenticator: options.deps.authenticator,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveHealth(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleHealthReadRequest({
    authenticator: options.deps.authenticator, health: options.health,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveActivity(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleActivityReadRequest({
    activity: options.activity, authenticator: options.deps.authenticator,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveSessions(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleSessionsReadRequest({
    authenticator: options.deps.authenticator, sessions: options.sessions,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveRepositoryRemote(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleRepositoryRemoteReadRequest({
    authenticator: options.deps.authenticator, repositoryRemote: options.repositoryRemote,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveGoalSource(
  response: ServerResponse, request: IncomingMessage, options: StartListenerOptions, body: Uint8Array,
): void {
  const result = handleGoalSourceReadRequest({
    authenticator: options.deps.authenticator, goalSource: options.goalSource,
  }, { body, credential: credentialOf(request), protocolVersion: protocolVersionOf(request) });
  if (result.kind === "LISTENER_REFUSAL") { refuseRequest(response, result.code); return; }
  reply(response, result.httpStatus, result.body);
}

function serveDocumentIngest(
  response: ServerResponse,
  request: IncomingMessage,
  options: StartListenerOptions,
  body: Uint8Array,
): void {
  const result = handleDocumentIngestRequest({
    authenticator: options.deps.authenticator,
    documentIngest: options.documentIngest,
  }, {
    body,
    credential: credentialOf(request),
    protocolVersion: protocolVersionOf(request),
  });
  if (result.kind === "LISTENER_REFUSAL") {
    refuseRequest(response, result.code);
    return;
  }
  reply(response, result.httpStatus, result.body);
}

/**
 * The facade calls this AFTER the handshake surface and the retired-approve tombstone have
 * had their turn, so this module never sees a path either of those owns.
 */
export async function serveReadDispatch(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartListenerOptions,
  authority: string,
  origin: string,
  assets: ControlRoomAssetRoot | null,
  path: string,
): Promise<void> {
  if (!JSON_ROUTES.includes(path)) {
    // No hosted bundle means the answer is the one it always was. The static
    // host is reached only when a root was resolved at startup, so a daemon
    // started without one behaves exactly as it did before it existed.
    if (assets === null) {
      refuseRequest(response, "LISTENER_ROUTE_UNKNOWN");
      return;
    }
    serveAsset(response, request, assets, authority, path);
    return;
  }
  const headerFault = checkHeaders(request, authority, origin, options.csrfToken);
  if (headerFault !== null) {
    refuseRequest(response, headerFault);
    return;
  }
  if (path === DOCUMENT_DOSSIER_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_DOCUMENT_DOSSIER_REQUEST_INVALID");
    return;
  }
  if (path === PLANNING_RUN_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PLANNING_RUN_REQUEST_INVALID");
    return;
  }
  if (path === GOAL_CATALOG_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_GOAL_CATALOG_REQUEST_INVALID");
    return;
  }
  if (path === DOCUMENT_INGEST_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID");
    return;
  }
  if (path === BUDGET_COMMITMENT_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_BUDGET_COMMITMENT_REQUEST_INVALID");
    return;
  }
  if (path === PRODUCT_CONTRACT_GATE_1_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID");
    return;
  }
  if (path === PRODUCT_CONTRACT_PENDING_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_PENDING_REQUEST_INVALID");
    return;
  }
  if (path === PRODUCT_CONTRACT_V2_CURRENT_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_V2_CURRENT_REQUEST_INVALID");
    return;
  }
  if (path === PRODUCT_CONTRACT_V2_PENDING_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_PRODUCT_CONTRACT_V2_PENDING_REQUEST_INVALID");
    return;
  }
  if (path === SESSION_CHALLENGE_OPERANDS_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_SESSION_CHALLENGE_OPERANDS_REQUEST_INVALID");
    return;
  }
  if (path === ACTIVITY_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_ACTIVITY_REQUEST_INVALID");
    return;
  }
  if (path === SESSIONS_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_SESSIONS_REQUEST_INVALID");
    return;
  }
  if (path === REPOSITORY_REMOTE_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_REPOSITORY_REMOTE_REQUEST_INVALID");
    return;
  }
  if (path === GOAL_SOURCE_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_GOAL_SOURCE_REQUEST_INVALID");
    return;
  }
  if (path === POLICY_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_POLICY_REQUEST_INVALID");
    return;
  }
  if (path === ACTIVATION_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_ACTIVATION_REQUEST_INVALID");
    return;
  }
  if (path === HEALTH_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_HEALTH_REQUEST_INVALID");
    return;
  }
  if (path === RUNS_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_RUNS_REQUEST_INVALID");
    return;
  }
  if (path === DOCUMENT_COVERAGE_READ_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_DOCUMENT_COVERAGE_REQUEST_INVALID");
    return;
  }
  if (path === V2_COMMAND_PATH && request.method !== "POST") {
    refuseRequest(response, "LISTENER_V2_COMMAND_REQUEST_INVALID");
    return;
  }
  const body = await readBoundedBody(request);
  if (body === null) {
    refuseRequest(response, "LISTENER_BODY_TOO_LARGE");
    return;
  }

  if (path === COMMAND_PATH) await serveCommand(response, request, options, body);
  else if (path === V2_COMMAND_PATH) await serveV2Command(response, request, options, body);
  else if (path === EVENT_PAGE_PATH) serveEventPage(response, request, options, body);
  else if (path === EVENT_ACKNOWLEDGE_PATH) serveEventAcknowledge(response, request, options, body);
  else if (path === EVENT_RESUME_PATH) serveEventResume(response, request, options);
  else if (path === AFFORDANCE_PATH) serveAffordances(response, request, options, body);
  else if (path === GRAPH_GET_PATH) serveGraphQuery(response, request, options, body);
  else if (path === GOAL_CATALOG_READ_PATH) serveGoalCatalog(response, request, options, body);
  else if (path === PLANNING_RUN_READ_PATH) servePlanningRun(response, request, options, body);
  else if (path === DOCUMENT_INGEST_PATH) serveDocumentIngest(response, request, options, body);
  else if (path === BUDGET_COMMITMENT_READ_PATH) {
    serveBudgetCommitmentRead(response, request, options, body);
  } else if (path === PRODUCT_CONTRACT_GATE_1_READ_PATH) {
    serveProductContractGate1(response, request, options, body);
  } else if (path === ACTIVITY_READ_PATH) {
    serveActivity(response, request, options, body);
  } else if (path === SESSIONS_READ_PATH) {
    serveSessions(response, request, options, body);
  } else if (path === REPOSITORY_REMOTE_READ_PATH) {
    serveRepositoryRemote(response, request, options, body);
  } else if (path === GOAL_SOURCE_READ_PATH) {
    serveGoalSource(response, request, options, body);
  } else if (path === POLICY_READ_PATH) {
    servePolicy(response, request, options, body);
  } else if (path === ACTIVATION_READ_PATH) {
    await serveActivation(response, request, options, body);
  } else if (path === HEALTH_READ_PATH) {
    serveHealth(response, request, options, body);
  } else if (path === RUNS_READ_PATH) {
    serveRuns(response, request, options, body);
  } else if (path === DOCUMENT_COVERAGE_READ_PATH) {
    serveDocumentCoverage(response, request, options, body);
  } else if (path === PRODUCT_CONTRACT_PENDING_READ_PATH) {
    serveProductContractPending(response, request, options, body);
  } else if (path === PRODUCT_CONTRACT_V2_CURRENT_READ_PATH) {
    serveProductContractV2Current(response, request, options, body);
  } else if (path === PRODUCT_CONTRACT_V2_PENDING_READ_PATH) {
    serveProductContractV2Pending(response, request, options, body);
  } else if (path === SESSION_CHALLENGE_OPERANDS_READ_PATH) {
    serveSessionChallengeOperands(response, request, options, body);
  } else serveDocumentDossier(response, request, options, body);
}
