import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { authorityOf, originOf } from "../http/http-listener-guards.js";
import { createPairingApprovalWindow } from "../http/pairing-approval-window.js";
import type {
  PairingApprovalGranted,
  PairingApprovalRefusal,
  PairingRandomBytesSource,
} from "../http/pairing-approval-window.js";
import { resolveControlRoomAssetRoot } from "../http/static-asset-host.js";
import { isManagerSecret, managerRefusal } from "./project-manager-http-contract.js";
import type {
  ProjectManagerHttpCode,
  ProjectManagerPort,
} from "./project-manager-http-contract.js";
import {
  refuseManagerRequest,
  serveProjectManagerRequest,
} from "./project-manager-http-routing.js";
import type { ProjectManagerRequestContext } from "./project-manager-http-routing.js";

export {
  PROJECT_MANAGER_CREDENTIAL_HEADER,
  PROJECT_MANAGER_HTTP_CODES,
  PROJECT_MANAGER_HTTP_LAYER,
  PROJECT_MANAGER_LIFECYCLES,
  PROJECT_MANAGER_MAX_BODY_BYTES,
  PROJECT_MANAGER_PROTOCOL_VERSION,
} from "./project-manager-http-contract.js";
export type {
  ProjectManagerHttpCode,
  ProjectManagerHttpResult,
  ProjectManagerIntake,
  ProjectManagerLifecycle,
  ProjectManagerPort,
  ProjectManagerProject,
  ProjectManagerProjectList,
} from "./project-manager-http-contract.js";

export interface ProjectManagerHttpListener {
  approvePairing(
    confirmationLabel: unknown,
  ): PairingApprovalGranted | PairingApprovalRefusal;
  close(): Promise<void>;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
}

export interface StartProjectManagerHttpOptions {
  /** Absolute directory containing the built control-room `index.html`. */
  readonly assetRoot: string;
  /** Runtime-only CSRF secret returned by `/manager/bootstrap`. */
  readonly csrfToken: string;
  /** The sole lifecycle authority. The HTTP seam only validates and forwards. */
  readonly manager: ProjectManagerPort;
  /** Injected only for deterministic request/label tests. */
  readonly pairingRandomBytes?: PairingRandomBytesSource;
  /** Injected for deterministic tests; production uses the system CSPRNG. */
  readonly mintSessionSecret?: () => string;
  /** Monotonic pairing-window clock; production uses `performance.now`. */
  readonly monotonicNow?: () => number;
  /** Omitted or zero lets the OS assign a port; the singleton launcher pins 39122. */
  readonly port?: number;
}

export type StartProjectManagerHttpResult = ProjectManagerHttpListener | Readonly<{
  readonly code: ProjectManagerHttpCode;
  readonly layer: "PROJECT_MANAGER_HTTP";
  readonly ok: false;
}>;

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function mintedSessionSecret(options: StartProjectManagerHttpOptions): string | null {
  let sessionSecret: unknown;
  try {
    sessionSecret = (options.mintSessionSecret ?? randomUUID)();
  } catch { return null; }
  return isManagerSecret(sessionSecret) && sessionSecret !== options.csrfToken
    ? sessionSecret : null;
}

/**
 * Starts the singleton manager surface on the configured or OS-assigned IPv4 loopback port.
 * Secrets and session state live only in this closure and die with the listener.
 */
export async function startProjectManagerHttp(
  options: StartProjectManagerHttpOptions,
): Promise<StartProjectManagerHttpResult> {
  if (options.port !== undefined
    && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    return managerRefusal("PROJECT_MANAGER_PORT_INVALID");
  }
  if (!isManagerSecret(options.csrfToken)) {
    return managerRefusal("PROJECT_MANAGER_SECRET_MINT_FAILED");
  }
  const sessionSecret = mintedSessionSecret(options);
  if (sessionSecret === null) return managerRefusal("PROJECT_MANAGER_SECRET_MINT_FAILED");
  const assets = resolveControlRoomAssetRoot(options.assetRoot, [
    options.csrfToken, sessionSecret,
  ]);
  if (assets.kind === "LISTENER_REFUSAL") return managerRefusal(assets.code);

  // A separate loopback address from the project daemons' 127.0.0.1, so the two surfaces
  // never share an origin. It is NOT a credential boundary on its own: the browser
  // partitions by host, not by port, which is why this listener hands its credential over
  // on PROJECT_MANAGER_CREDENTIAL_HEADER instead of a cookie any 127.0.0.2 port would receive.
  const host = "127.0.0.2";
  const pairing = createPairingApprovalWindow({
    ...(options.monotonicNow === undefined ? {} : { now: options.monotonicNow }),
    ...(options.pairingRandomBytes === undefined ? {} : { randomBytes: options.pairingRandomBytes }),
  });
  let context: ProjectManagerRequestContext | null = null;
  let server: Server | null = null;
  try {
    server = createServer((request, response) => {
      const active = context;
      if (active === null) {
        refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_FAILED");
        return;
      }
      void serveProjectManagerRequest(request, response, active).catch(() => {
        if (!response.headersSent) refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_FAILED");
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
      return managerRefusal("PROJECT_MANAGER_BIND_FAILED");
    }
    const port = address.port;
    const authority = authorityOf(host, port);
    const origin = originOf(host, port);
    context = Object.freeze({ assets, authority, csrfToken: options.csrfToken,
      manager: options.manager, origin, pairing, sessionSecret });
    return Object.freeze({
      approvePairing: (confirmationLabel: unknown) => pairing.operator.approve(confirmationLabel),
      close: async (): Promise<void> => { context = null; pairing.close(); await closeServer(bound); },
      ok: true as const,
      origin,
      port,
    });
  } catch {
    pairing.close();
    if (server !== null) await closeServer(server);
    return managerRefusal("PROJECT_MANAGER_BIND_FAILED");
  }
}
