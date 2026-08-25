import type { IncomingMessage, ServerResponse } from "node:http";

import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
  pairingApprovalStatusFor,
} from "../http/pairing-approval-handshake.js";
import { refusePairingApproval } from "../http/pairing-approval-window.js";
import type {
  PairingApprovalRefusal,
  PairingApprovalWindow,
} from "../http/pairing-approval-window.js";
import { CONTROL_ROOM_ASSET_RESPONSE_HEADERS } from "../http/static-asset-host.js";
import type { ControlRoomAssetRoot } from "../http/static-asset-host.js";
import { serveProjectManagerAsset } from "./project-manager-http-assets.js";
import {
  PROJECT_MANAGER_COOKIE_NAME,
  PROJECT_MANAGER_HTTP_LAYER,
  PROJECT_MANAGER_PROTOCOL_VERSION,
  decodeManagerIntake,
  decodeManagerList,
  decodeManagerPairingClaim,
  decodeManagerResult,
  isEmptyManagerBody,
  isManagerPairingRequest,
  isManagerInstanceId,
  managerRefusal,
  managerStatus,
  readManagerBody,
  requestHasSession,
} from "./project-manager-http-contract.js";
import type {
  ProjectManagerHttpCode,
  ProjectManagerIntake,
  ProjectManagerPort,
} from "./project-manager-http-contract.js";

export interface ProjectManagerRequestContext {
  readonly assets: ControlRoomAssetRoot;
  readonly authority: string;
  readonly csrfToken: string;
  readonly manager: ProjectManagerPort;
  readonly origin: string;
  readonly pairing: PairingApprovalWindow;
  readonly sessionSecret: string;
}

type Headers = Readonly<Record<string, string>>;
const JSON_POLICY = Object.freeze({ ...CONTROL_ROOM_ASSET_RESPONSE_HEADERS, "cache-control": "no-store" });
const PROTOCOL_HEADER = "x-moe-manager-protocol-version";
const CSRF_HEADER = "x-moe-manager-csrf";

function reply(response: ServerResponse, status: number, body: unknown, headers: Headers = JSON_POLICY): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, { ...headers, "content-length": bytes.byteLength,
    "content-type": "application/json; charset=utf-8" });
  response.end(bytes);
}

export function refuseManagerRequest(response: ServerResponse, code: ProjectManagerHttpCode): void {
  reply(response, managerStatus(code), managerRefusal(code));
}

function hostFault(request: IncomingMessage, context: ProjectManagerRequestContext): boolean {
  return request.headers.host !== context.authority;
}

function mutationFault(
  request: IncomingMessage, context: ProjectManagerRequestContext,
): ProjectManagerHttpCode | null {
  if (hostFault(request, context)) return "PROJECT_MANAGER_HOST_INVALID";
  if (request.headers.origin !== context.origin) return "PROJECT_MANAGER_ORIGIN_INVALID";
  if (context.csrfToken === "" || request.headers[CSRF_HEADER] !== context.csrfToken) {
    return "PROJECT_MANAGER_CSRF_INVALID";
  }
  if (request.headers[PROTOCOL_HEADER] !== PROJECT_MANAGER_PROTOCOL_VERSION) {
    return "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED";
  }
  if (!requestHasSession(request, context.sessionSecret)) {
    return "PROJECT_MANAGER_AUTHENTICATION_REQUIRED";
  }
  return null;
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  return request.headers["content-type"] === "application/json";
}

function serveBootstrap(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
): void {
  if (hostFault(request, context)) {
    refuseManagerRequest(response, "PROJECT_MANAGER_HOST_INVALID");
    return;
  }
  if (request.method !== "GET") {
    refuseManagerRequest(response, "PROJECT_MANAGER_METHOD_INVALID");
    return;
  }
  reply(response, 200, {
    authenticated: requestHasSession(request, context.sessionSecret),
    csrfToken: context.csrfToken,
    schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION,
  });
}

async function servePair(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
): Promise<void> {
  if (hostFault(request, context)) {
    refuseManagerRequest(response, "PROJECT_MANAGER_HOST_INVALID");
    return;
  }
  if (request.method !== "POST") {
    refuseManagerRequest(response, "PROJECT_MANAGER_METHOD_INVALID");
    return;
  }
  if (request.headers.origin !== context.origin) {
    refuseManagerRequest(response, "PROJECT_MANAGER_ORIGIN_INVALID");
    return;
  }
  if (context.csrfToken === "" || request.headers[CSRF_HEADER] !== context.csrfToken) {
    refuseManagerRequest(response, "PROJECT_MANAGER_CSRF_INVALID");
    return;
  }
  if (request.headers[PROTOCOL_HEADER] !== PROJECT_MANAGER_PROTOCOL_VERSION) {
    refuseManagerRequest(response, "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED");
    return;
  }
  if (!contentTypeIsJson(request)) {
    refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_INVALID");
    return;
  }
  const body = await readManagerBody(request, PAIRING_APPROVAL_MAX_BODY_BYTES);
  if (body === null) {
    refuseManagerRequest(response, "PROJECT_MANAGER_BODY_TOO_LARGE");
    return;
  }
  if (!isManagerPairingRequest(body)) {
    refusePairing(response, refusePairingApproval("PAIRING_CREATE_REQUEST_INVALID"));
    return;
  }
  const created = context.pairing.requests.create();
  if (!created.ok) { refusePairing(response, created); return; }
  reply(response, 200, created);
}

function refusePairing(response: ServerResponse, refusal: PairingApprovalRefusal): void {
  reply(response, pairingApprovalStatusFor(refusal.code), refusal);
}

async function servePairClaim(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
): Promise<void> {
  if (hostFault(request, context)) { refuseManagerRequest(response, "PROJECT_MANAGER_HOST_INVALID"); return; }
  if (request.method !== "POST") { refuseManagerRequest(response, "PROJECT_MANAGER_METHOD_INVALID"); return; }
  if (request.headers.origin !== context.origin) { refuseManagerRequest(response, "PROJECT_MANAGER_ORIGIN_INVALID"); return; }
  if (context.csrfToken === "" || request.headers[CSRF_HEADER] !== context.csrfToken) {
    refuseManagerRequest(response, "PROJECT_MANAGER_CSRF_INVALID"); return;
  }
  if (request.headers[PROTOCOL_HEADER] !== PROJECT_MANAGER_PROTOCOL_VERSION) {
    refuseManagerRequest(response, "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED"); return;
  }
  if (!contentTypeIsJson(request)) { refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_INVALID"); return; }
  const body = await readManagerBody(request, PAIRING_APPROVAL_MAX_BODY_BYTES);
  if (body === null) { refuseManagerRequest(response, "PROJECT_MANAGER_BODY_TOO_LARGE"); return; }
  const requestId = decodeManagerPairingClaim(body);
  if (requestId === null) {
    refusePairing(response, refusePairingApproval("PAIRING_CLAIM_REQUEST_INVALID")); return;
  }
  const reserved = context.pairing.requests.reserve(requestId);
  if (!reserved.ok) { refusePairing(response, reserved); return; }
  try {
    reply(response, 200, {
      code: "PROJECT_MANAGER_PAIRED", layer: PROJECT_MANAGER_HTTP_LAYER, ok: true,
    }, { ...JSON_POLICY,
      "set-cookie": `${PROJECT_MANAGER_COOKIE_NAME}=${context.sessionSecret}; HttpOnly; SameSite=Strict; Path=/manager` });
  } finally {
    // Once a cookie response may have crossed the socket, ambiguity burns the
    // request. Releasing it could admit a second browser.
    reserved.reservation.commit();
  }
}

async function serveList(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
): Promise<void> {
  if (hostFault(request, context)) {
    refuseManagerRequest(response, "PROJECT_MANAGER_HOST_INVALID");
    return;
  }
  if (request.method !== "GET") {
    refuseManagerRequest(response, "PROJECT_MANAGER_METHOD_INVALID");
    return;
  }
  if (!requestHasSession(request, context.sessionSecret)) {
    refuseManagerRequest(response, "PROJECT_MANAGER_AUTHENTICATION_REQUIRED");
    return;
  }
  let value: unknown;
  try { value = await context.manager.list(); }
  catch { refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_FAILED"); return; }
  const decoded = decodeManagerList(value);
  if (decoded === null) {
    refuseManagerRequest(response, "PROJECT_MANAGER_PORT_RESULT_INVALID");
    return;
  }
  reply(response, 200, decoded);
}

async function serveMutation(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
  kind: "create" | "open" | "register" | "start" | "stop", argument: string | null,
): Promise<void> {
  if (request.method !== "POST") {
    refuseManagerRequest(response, "PROJECT_MANAGER_METHOD_INVALID");
    return;
  }
  const fault = mutationFault(request, context);
  if (fault !== null) { refuseManagerRequest(response, fault); return; }
  if (!contentTypeIsJson(request)) { refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_INVALID"); return; }
  const body = await readManagerBody(request);
  if (body === null) { refuseManagerRequest(response, "PROJECT_MANAGER_BODY_TOO_LARGE"); return; }
  let input: ProjectManagerIntake | string;
  if (kind === "create" || kind === "register") {
    const intake = decodeManagerIntake(body);
    if (intake === null) { refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_INVALID"); return; }
    input = intake;
  } else {
    if (argument === null || !isManagerInstanceId(argument) || !isEmptyManagerBody(body)) {
      refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_INVALID");
      return;
    }
    input = argument;
  }
  let value: unknown;
  try {
    value = kind === "create" || kind === "register"
      ? await context.manager[kind](input as ProjectManagerIntake)
      : await context.manager[kind](input as string);
  } catch { refuseManagerRequest(response, "PROJECT_MANAGER_REQUEST_FAILED"); return; }
  const decoded = decodeManagerResult(value, kind === "open");
  if (decoded === null) { refuseManagerRequest(response, "PROJECT_MANAGER_PORT_RESULT_INVALID"); return; }
  reply(response, 200, decoded);
}

export async function serveProjectManagerRequest(
  request: IncomingMessage, response: ServerResponse, context: ProjectManagerRequestContext,
): Promise<void> {
  const raw = request.url ?? "";
  const path = raw.split("?")[0] ?? "";
  if (path === "/manager/bootstrap" && raw === path) { serveBootstrap(request, response, context); return; }
  if (path === "/manager/session/pair/request" && raw === path) {
    await servePair(request, response, context); return;
  }
  if (path === "/manager/session/pair/claim" && raw === path) {
    await servePairClaim(request, response, context); return;
  }
  if (path === "/manager/projects" && raw === path) { await serveList(request, response, context); return; }
  if (raw === path && (path === "/manager/projects/create" || path === "/manager/projects/register")) {
    await serveMutation(request, response, context, path.endsWith("create") ? "create" : "register", null);
    return;
  }
  const action = raw === path
    ? /^\/manager\/projects\/([^/]+)\/(start|stop|open)$/u.exec(path) : null;
  if (action !== null) {
    const instanceId = action[1] ?? null;
    const kind = action[2] as "open" | "start" | "stop";
    if (instanceId !== null && isManagerInstanceId(instanceId)) {
      await serveMutation(request, response, context, kind, instanceId);
      return;
    }
  }
  if (path.startsWith("/manager")) { refuseManagerRequest(response, "PROJECT_MANAGER_ROUTE_UNKNOWN"); return; }
  serveProjectManagerAsset(request, response, context.assets, context.authority, path,
    refuseManagerRequest);
}
