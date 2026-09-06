import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AffordancePort } from "./affordance-contract.js";
import type { DocumentDossierReadPort } from "./document-dossier-read.js";
import type { DocumentIngestPort } from "./document-ingest-route.js";
import type { GoalCatalogReadPort } from "./goal-catalog-read.js";
import type { BudgetCommitmentReadPort } from "./budget-commitment-read.js";
import type { PlanningRunReadPort } from "./planning-run-read.js";
import type { ProductContractPendingReadPort } from "./product-contract-pending-read.js";
import type { ProductContractGate1ReadPort } from "./product-contract-gate-1-read.js";
import type { DocumentCoverageReadPort } from "./document-coverage-contract.js";
import type { RunsReadPort } from "./runs-read-contract.js";
import type { PolicyReadPort } from "./policy-read.js";
import type { ActivationReadPort } from "./activation-read.js";
import type { HealthReadPort } from "./health-read.js";
import type { ActivityReadPort } from "./activity-read.js";
import type { SessionsReadPort } from "./sessions-read.js";
import type { RepositoryRemoteReadPort } from "./repository-remote-read.js";
import type { RepositoryWorkflowReadPort } from "./repository-workflow-read.js";
import type { GoalSourceReadPort } from "../documents/document-source-full-read.js";
import type { DeploymentsHealthReadPort } from "./deployments-health-read.js";
import type { DesignReadPort } from "./design-read.js";
import type { EnvironmentsReadPort } from "./environments-read.js";
import type { PreviewCapturePort } from "./preview-capture-route.js";
import type { PreviewReadPort } from "./preview-read.js";
import type { ReleaseReadPort } from "./release-evidence-read.js";
import type {
  ProductContractV2CurrentReadPort,
} from "./product-contract-v2-current-read.js";
import type {
  ProductContractV2PendingReadPort,
} from "./product-contract-v2-pending-read.js";
import type { SessionChallengeOperandsReadPort } from "./session-challenge-operands-read.js";
import type { SubscriptionPort } from "./event-stream-contract.js";
import type { CommandAdapterDeps, CommandAuthorityPlanePort } from "./http-contract.js";
import type { GraphQueryPort } from "../planning/graph-query.js";
import { authorityOf, isLoopbackHost, originOf, refuse } from "./http-listener-guards.js";
import type { ListenerRefused } from "./http-listener-guards.js";
import { resolveControlRoomAssetRoot } from "./static-asset-host.js";
import type { ControlRoomAssetRoot } from "./static-asset-host.js";
import type { SessionHandshakePort } from "../identity/session-handshake.js";
import { createPairingApprovalHandshake } from "./pairing-approval-handshake.js";
import type { PairingApprovalHandshakePort } from "./pairing-approval-handshake.js";
import { createPairingOpenCompletion } from "./pairing-open-completion.js";
import type {
  PairingOpenCompletionPort, PairingOpenSessionPort,
} from "./pairing-open-completion.js";
import { createPairingApprovalWindow } from "./pairing-approval-window.js";
import type {
  PairingApprovalGranted,
  PairingApprovalRefusal,
} from "./pairing-approval-window.js";
// THE HANDSHAKE SURFACE, including the retired-approve tombstone and the bootstrap body:
// one module owns the whole ingress and the order it answers in. `composeBootstrapBody`
// is re-exported below so this facade's public surface is byte-for-byte what it was.
import { serveHandshakeIngress } from "./http-listener-pairing-routes.js";
export { composeBootstrapBody } from "./http-listener-pairing-routes.js";
// THE COMMAND AND STREAM SURFACE plus the shared wire helpers, extracted verbatim.
import { refuseRequest } from "./http-listener-command-stream-routes.js";
// THE READ AND ASSET DISPATCH. The JSON_ROUTES roster travels with the dispatch that tests
// it, so this facade no longer names a single JSON path.
import { serveReadDispatch } from "./http-listener-read-dispatch.js";

export {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
} from "./http-listener-guards.js";
export type { ListenerRefusalCode, ListenerRefused } from "./http-listener-guards.js";

/**
 * The socket, and only the socket.
 *
 * Everything from authentication onward is already committed in
 * `handleCommandRequest`, and the resumable stream is already committed in
 * `readEventPage`. This module binds, guards the headers the adapter never
 * sees, and routes. Authentication and compatibility stay in their shared
 * adapter gate; this socket performs no capability check, command decode, or
 * error mapping of its own.
 */
export interface ControlRoomListener {
  approvePairing(
    confirmationLabel: unknown,
  ): PairingOperatorApprovalResult;
  close(): Promise<void>;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
}

export type PairingOperatorApprovalResult =
  | PairingApprovalGranted | PairingApprovalRefusal | ListenerRefused;

export type StartListenerResult = ControlRoomListener | ListenerRefused;

export interface StartListenerOptions {
  /** Absent means the affordance route refuses rather than inventing an offer. */
  readonly affordances?: AffordancePort;
  /**
   * An ABSOLUTE directory of built control-room assets, hosted on this same
   * origin so an operator needs one process and one URL. Absent means this
   * daemon hosts no bundle at all and every path outside the JSON routes stays
   * `LISTENER_ROUTE_UNKNOWN`, exactly as before this option existed. Present, it
   * is resolved ONCE below, before the socket binds, and a root that cannot be
   * proven refuses the START rather than being served from.
   */
  readonly assetRoot?: string;
  /**
   * In-process secrets no hosted asset may contain. The CSRF token is always
   * added here; the caller supplies the rest (the daemon credential). A root
   * whose servable files carry any of them refuses the START with
   * `LISTENER_ASSET_ROOT_LEAKS_SECRET` - see the static host's header for why.
   */
  readonly assetSecrets?: readonly string[];
  readonly csrfToken: string;
  readonly deps: CommandAdapterDeps;
  /**
   * The separately composed `/2` registry. Absence is an explicit unavailable
   * authority plane; it never falls back to the v1 registry in `deps`.
   */
  readonly v2Deps?: CommandAdapterDeps;
  /**
   * States on `/bootstrap` which plane a browser must write to. Absent means the
   * listener answers V1, the plane `/command` serves when no cutover marker exists;
   * a composed reader answers from the durable marker on every request.
   */
  readonly commandAuthorityPlane?: CommandAuthorityPlanePort;
  /** Absent means an authenticated dossier read refuses rather than inventing one. */
  readonly documentDossiers?: DocumentDossierReadPort;
  /** Absent means the operator ingest route refuses rather than recording a document. */
  readonly documentIngest?: DocumentIngestPort;
  /** Absent means the graph route refuses rather than inventing a snapshot. */
  readonly graph?: GraphQueryPort;
  /** Absent means the authenticated goal catalog route refuses rather than inventing rows. */
  readonly goalCatalog?: GoalCatalogReadPort;
  /**
   * Absent means the budget commitment read route refuses rather than answering
   * a commitment it did not derive: a missing port can never read as a value.
   */
  readonly budgetCommitment?: BudgetCommitmentReadPort;
  /**
   * Absent means the Gate 1 read route refuses rather than answering an
   * unattested gate: a missing port can never read as a satisfied one.
   */
  readonly productContractGate1?: ProductContractGate1ReadPort;
  /** Absent means the PRD coverage read refuses as unavailable rather than inventing zeros. */
  readonly documentCoverage?: DocumentCoverageReadPort;
  /** Absent means the runs read refuses as unavailable rather than inventing an empty board. */
  readonly runs?: RunsReadPort;
  /** Absent means the policy read refuses as unavailable. */
  readonly policy?: PolicyReadPort;
  /** Absent means the activation receipts read refuses as unavailable. */
  readonly activation?: ActivationReadPort;
  /** Absent means the health read refuses as unavailable. */
  readonly health?: HealthReadPort;
  /** Absent means the activity read refuses as unavailable. */
  readonly activity?: ActivityReadPort;
  /** Absent means the sessions read refuses as unavailable. */
  readonly sessions?: SessionsReadPort;
  /** Absent means the repository-remote read refuses as unavailable. */
  readonly repositoryRemote?: RepositoryRemoteReadPort;
  readonly repositoryWorkflows?: RepositoryWorkflowReadPort;
  /** Absent means the goal-source (PRD text) read refuses as unavailable. */
  readonly goalSource?: GoalSourceReadPort;
  /** Absent means the design-revision read refuses as unavailable. */
  readonly designReads?: DesignReadPort;
  /** Absent means the per-environment variable-table read refuses as unavailable. */
  readonly environmentReads?: EnvironmentsReadPort;
  /**
   * Absent means the deployment-environment health read refuses as UNAVAILABLE. Never a healthy
   * default: a daemon composed without this port cannot see any environment, and answering UP
   * for all of them is the most dangerous output a health route has.
   */
  readonly deploymentsHealth?: DeploymentsHealthReadPort;
  /**
   * Absent means the preview receipt read refuses as unavailable rather than answering ABSENT:
   * an unwired daemon must not tell a card "this goal has no preview".
   */
  readonly previewReads?: PreviewReadPort;
  readonly releaseReads?: ReleaseReadPort;
  /**
   * Absent means the capture-bytes route refuses as unavailable. Present, it names the
   * ABSOLUTE project directory `.moe-next/previews` sits under; the route proves that root by
   * realpath on every request and confines every read to it.
   */
  readonly previewCaptures?: PreviewCapturePort;
  /** Absent means the pending-contract read refuses rather than inventing one. */
  readonly productContractPending?: ProductContractPendingReadPort;
  /** Absent means the activated `/2` current-contract read refuses as unavailable. */
  readonly productContractV2Current?: ProductContractV2CurrentReadPort;
  /** Absent means the activated `/2` pending-contract read refuses as unavailable. */
  readonly productContractV2Pending?: ProductContractV2PendingReadPort;
  /**
   * Optional for the same reason as the gate above: a daemon composed without
   * it answers UNAVAILABLE rather than publishing a fabricated operand set.
   */
  readonly sessionChallengeOperands?: SessionChallengeOperandsReadPort;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly onRequest?: () => void;
  /**
   * The runtime credential mint invoked only after an approved pairing claim,
   * and the source of the `projectId` `/bootstrap` answers. Absent means neither
   * handshake route is available and both refuse `LISTENER_PAIRING_UNAVAILABLE`
   * - a daemon hosting no page needs no handshake.
   */
  readonly pairing?: SessionHandshakePort;
  /**
   * The session authority the open completion composes. Absent means the completion
   * route refuses LISTENER_PAIRING_UNAVAILABLE: a daemon that holds no authority must
   * not answer as though it verified a proof.
   */
  readonly pairingOpenSessions?: PairingOpenSessionPort;
  /** Explicit process fact; absence fails closed to no attached operator channel. */
  readonly pairingOperatorChannelAvailable?: boolean;
  /** Monotonic clock for the request/approval window; production uses `performance.now`. */
  readonly pairingMonotonicNow?: () => number;
  /** Absent means the pending-plan read route refuses rather than inventing a run. */
  readonly planningRuns?: PlanningRunReadPort;
  readonly port?: number;
  /** Absent means the stream route refuses rather than inventing an empty page. */
  readonly subscriptions?: SubscriptionPort;
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartListenerOptions,
  authority: string,
  origin: string,
  assets: ControlRoomAssetRoot | null,
  pairingApproval: PairingApprovalHandshakePort | null,
  pairingCompletion: PairingOpenCompletionPort | null,
): Promise<void> {
  options.onRequest?.();
  // Logged without a query string. Pairing request identity travels only in a
  // bounded claim body, and the session credential exists only in the successful
  // claim response, so neither reaches this log line.
  const rawPath = request.url ?? "";
  const path = rawPath.split("?")[0] ?? "";
  options.log?.(`${request.method ?? "?"} ${path}`);

  // THE HANDSHAKE SURFACE, delegated whole and answered FIRST. It owns bootstrap,
  // session-pair, request/claim/open and the retired-approve tombstone, so all four still
  // precede the JSON_ROUTES/asset split exactly as they did when this dispatch lived
  // inline - which is what makes a hosted and an unhosted listener answer
  // /session/pair/approve identically.
  const answered = await serveHandshakeIngress(response, request, options, {
    authority,
    completion: pairingCompletion,
    handshake: pairingApproval,
    origin,
    path,
    rawPath,
  });
  if (answered) return;

  // THE READ AND ASSET SURFACE, delegated whole. Everything above answered first, so the
  // handshake routes and the tombstone still precede the JSON/asset split exactly as they
  // did when this dispatch lived inline.
  await serveReadDispatch(request, response, options, authority, origin, assets, path);
}

export async function startControlRoomListener(
  options: StartListenerOptions,
): Promise<StartListenerResult> {
  const host = options.host ?? "127.0.0.1";
  // Refuses to START, not warns. Design 19.2: loopback is the only default
  // bind, and a transport that reaches a public interface on a host also
  // running agent processes is an exposure rather than a convenience.
  if (!isLoopbackHost(host)) return refuse("LISTENER_NON_LOOPBACK_BIND");

  // Resolved ONCE, here, before a socket exists. A root re-derived per request
  // is a root a caller can race, and one that cannot be proven now is a reason
  // not to start rather than a reason to serve from an unproven directory.
  let assets: ControlRoomAssetRoot | null = null;
  if (options.assetRoot !== undefined) {
    // The CSRF token is this listener's own secret, so it joins the scan here;
    // the caller's list carries the rest. An empty caller list still scans for
    // the token, and an empty token is dropped by the host, not matched everywhere.
    const resolvedRoot = resolveControlRoomAssetRoot(
      options.assetRoot, [options.csrfToken, ...(options.assetSecrets ?? [])],
    );
    if (resolvedRoot.kind === "LISTENER_REFUSAL") {
      return refuse(resolvedRoot.code, resolvedRoot.detail);
    }
    assets = resolvedRoot;
  }

  // Filled in AFTER the bind, when the port is known; the handler closes over
  // the variables rather than over a `const` declared further down, so a request
  // that somehow raced the bind would fail the Host check rather than throw a
  // ReferenceError out of the request handler.
  let authority = "";
  let origin = "";
  let server: Server | null = null;
  const requestOptions = options;
  const pairingApprovalWindow = createPairingApprovalWindow(
    requestOptions.pairingMonotonicNow === undefined
      ? {}
      : { now: requestOptions.pairingMonotonicNow },
  );
  const pairingApproval = requestOptions.pairing === undefined
    ? null
    // The operand source is FORWARDED, not rebuilt: the same port the challenge-operands
    // read route publishes is the one the approved claim discloses through, so the two
    // surfaces can never answer different scalars for one principal.
    : createPairingApprovalHandshake(
      pairingApprovalWindow.requests,
      requestOptions.pairing,
      requestOptions.sessionChallengeOperands,
    );
  const pairingCompletion = requestOptions.pairingOpenSessions === undefined
    ? null
    : createPairingOpenCompletion(requestOptions.pairingOpenSessions);
  try {
    server = createServer((request, response) => {
      const served = serve(
        request, response, requestOptions, authority, origin, assets, pairingApproval,
        pairingCompletion,
      );
      void served.catch((error: unknown) => {
        // A throw from the handler must still answer and must still leave the
        // listener closable; it may never surface as a hung socket. The cause is
        // logged host-side (never sent to the client) so a 500 stays diagnosable.
        const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        requestOptions.log?.(
          `LISTENER_REQUEST_FAILED ${request.method ?? "?"} ${request.url ?? "?"} ${cause}`,
        );
        if (!response.headersSent) refuseRequest(response, "LISTENER_REQUEST_FAILED");
        else response.end();
      });
    });

    const bound = server;
    await new Promise<void>((resolve, reject) => {
      bound.once("error", reject);
      bound.listen(options.port ?? 0, host, resolve);
    });

    const address = bound.address();
    if (address === null || typeof address === "string") {
      await closeServer(bound);
      return refuse("LISTENER_BIND_FAILED");
    }
    const port = address.port;
    authority = authorityOf(host, port);
    origin = originOf(host, port);
    let closed = false;

    return Object.freeze({
      approvePairing: (
        confirmationLabel: unknown,
      ): PairingOperatorApprovalResult =>
        closed || requestOptions.pairing === undefined
          ? refuse("LISTENER_PAIRING_UNAVAILABLE")
          : pairingApprovalWindow.operator.approve(confirmationLabel),
      close: async (): Promise<void> => {
        closed = true;
        pairingApprovalWindow.close();
        await closeServer(bound);
      },
      ok: true,
      origin,
      port,
    } as const);
  } catch {
    // Closed on the failure path too: a half-bound server left behind surfaces
    // later as EBUSY on Windows rather than as the real error.
    if (server !== null) await closeServer(server);
    return refuse("LISTENER_BIND_FAILED");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
