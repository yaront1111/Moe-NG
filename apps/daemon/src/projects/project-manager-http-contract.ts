import type { IncomingMessage } from "node:http";
import { win32 } from "node:path";
import { secretMatchesConstantTime } from "../http/http-listener-guards.js";

export const PROJECT_MANAGER_PROTOCOL_VERSION = "moe-project-manager/1" as const;
export const PROJECT_MANAGER_HTTP_LAYER = "PROJECT_MANAGER_HTTP" as const;
/**
 * The manager credential travels on a REQUEST HEADER, never a cookie. RFC 6265 has no
 * port attribute, so a cookie minted by this listener is replayed by the browser to
 * every other port on 127.0.0.2 - a same-user process that binds one of them collects
 * the credential without taking part in the pairing. No cookie attribute
 * (HttpOnly, SameSite, Secure, __Host-, Path, Partitioned) can express a port scope.
 * This mirrors the 127.0.0.1 project listener, which carries its credential on
 * `x-moe-session-credential` (http-listener-guards.ts).
 */
export const PROJECT_MANAGER_CREDENTIAL_HEADER = "x-moe-manager-session-credential" as const;
export const PROJECT_MANAGER_MAX_BODY_BYTES = 16 * 1024;

export const PROJECT_MANAGER_LIFECYCLES = Object.freeze([
  "STARTING", "RUNNING", "STOPPING", "STOPPED", "FAILED", "UNKNOWN",
] as const);
export type ProjectManagerLifecycle = (typeof PROJECT_MANAGER_LIFECYCLES)[number];
export const PROJECT_MANAGER_HTTP_CODES = Object.freeze([
  "PROJECT_MANAGER_AUTHENTICATION_REQUIRED",
  "PROJECT_MANAGER_BIND_FAILED",
  "PROJECT_MANAGER_BODY_TOO_LARGE",
  "PROJECT_MANAGER_CSRF_INVALID",
  "PROJECT_MANAGER_HOST_INVALID",
  "PROJECT_MANAGER_METHOD_INVALID",
  "PROJECT_MANAGER_ORIGIN_INVALID",
  "PROJECT_MANAGER_PORT_INVALID",
  "PROJECT_MANAGER_PORT_RESULT_INVALID",
  "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED",
  "PROJECT_MANAGER_REQUEST_FAILED",
  "PROJECT_MANAGER_REQUEST_INVALID",
  "PROJECT_MANAGER_ROUTE_UNKNOWN",
  "PROJECT_MANAGER_SECRET_MINT_FAILED",
  "PROJECT_MANAGER_PAIRED",
  "LISTENER_ASSET_ENCODING_INVALID",
  "LISTENER_ASSET_METHOD_INVALID",
  "LISTENER_ASSET_NOT_FOUND",
  "LISTENER_ASSET_OUTSIDE_ROOT",
  "LISTENER_ASSET_PATH_TRAVERSAL",
  "LISTENER_ASSET_READ_FAILED",
  "LISTENER_ASSET_ROOT_INVALID",
  "LISTENER_ASSET_ROOT_LEAKS_SECRET",
  "LISTENER_ASSET_SEGMENT_INVALID",
  "LISTENER_ASSET_TOO_LARGE",
  "LISTENER_ASSET_TYPE_UNKNOWN",
] as const);
export type ProjectManagerHttpCode = (typeof PROJECT_MANAGER_HTTP_CODES)[number];

export interface ProjectManagerHttpResult {
  readonly code: string;
  readonly layer: string;
  readonly ok: boolean;
  readonly origin?: string;
}

export interface ProjectManagerProject {
  readonly instanceId: string;
  readonly lifecycle: ProjectManagerLifecycle;
  readonly projectId: string;
  readonly root: string;
  readonly title: string;
}

export interface ProjectManagerProjectList {
  readonly projects: readonly ProjectManagerProject[];
  readonly schemaVersion: typeof PROJECT_MANAGER_PROTOCOL_VERSION;
}
export interface ProjectManagerPort {
  readonly create: (input: ProjectManagerIntake) => unknown | Promise<unknown>;
  readonly list: () => unknown | Promise<unknown>;
  readonly open: (instanceId: string) => unknown | Promise<unknown>;
  readonly register: (input: ProjectManagerIntake) => unknown | Promise<unknown>;
  readonly start: (instanceId: string) => unknown | Promise<unknown>;
  readonly stop: (instanceId: string) => unknown | Promise<unknown>;
}
export interface ProjectManagerIntake { readonly root: string; readonly title: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SECRET = /^[A-Za-z0-9._~-]{16,256}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function managerRefusal(code: ProjectManagerHttpCode): Readonly<{
  readonly code: ProjectManagerHttpCode; readonly layer: typeof PROJECT_MANAGER_HTTP_LAYER;
  readonly ok: false;
}> {
  return Object.freeze({ code, layer: PROJECT_MANAGER_HTTP_LAYER, ok: false });
}

export function managerStatus(code: ProjectManagerHttpCode): number {
  if (code === "PROJECT_MANAGER_AUTHENTICATION_REQUIRED") return 401;
  if (code === "PROJECT_MANAGER_METHOD_INVALID") return 405;
  if (code === "PROJECT_MANAGER_BODY_TOO_LARGE") return 413;
  if (code === "PROJECT_MANAGER_PORT_INVALID" || code === "PROJECT_MANAGER_REQUEST_INVALID"
    || code === "PROJECT_MANAGER_PROTOCOL_UNSUPPORTED"
    || code === "LISTENER_ASSET_ENCODING_INVALID") return 400;
  if (code === "PROJECT_MANAGER_ROUTE_UNKNOWN" || code === "LISTENER_ASSET_NOT_FOUND") return 404;
  if (code === "LISTENER_ASSET_TYPE_UNKNOWN") return 415;
  if (code === "PROJECT_MANAGER_PORT_RESULT_INVALID"
    || code === "PROJECT_MANAGER_REQUEST_FAILED"
    || code === "PROJECT_MANAGER_BIND_FAILED"
    || code === "PROJECT_MANAGER_SECRET_MINT_FAILED"
    || code === "LISTENER_ASSET_READ_FAILED") return 500;
  return 403;
}

export const isManagerSecret = (value: unknown): value is string =>
  typeof value === "string" && SECRET.test(value);
export const isManagerInstanceId = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length
      || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function exactArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length > 1024
      || Reflect.ownKeys(value).length !== value.length + 1) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function parseJson(bytes: Uint8Array): unknown | null {
  try { return JSON.parse(textDecoder.decode(bytes)) as unknown; }
  catch { return null; }
}

function title(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && textEncoder.encode(value).byteLength <= 512 && value.trim() === value
    && value === value.normalize("NFC") && !/[\u0000-\u001f\u007f]/u.test(value);
}

function localWindowsPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.trim() === value
    && value === value.normalize("NFC") && !value.includes("\0")
    && /^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value);
}

export function decodeManagerIntake(bytes: Uint8Array): ProjectManagerIntake | null {
  const value = record(parseJson(bytes), ["root", "title"]);
  if (value === null || !localWindowsPath(value["root"]) || !title(value["title"])) return null;
  return Object.freeze({ root: value["root"], title: value["title"] });
}

export function isEmptyManagerBody(bytes: Uint8Array): boolean {
  return bytes.byteLength === 0;
}

export function isManagerPairingRequest(bytes: Uint8Array): boolean {
  return record(parseJson(bytes), []) !== null;
}

export function decodeManagerPairingClaim(bytes: Uint8Array): string | null {
  const value = record(parseJson(bytes), ["requestId"]);
  const requestId = value?.["requestId"];
  return typeof requestId === "string" && /^[0-9a-f]{64}$/u.test(requestId)
    ? requestId : null;
}

export async function readManagerBody(
  request: IncomingMessage,
  maximumBytes = PROJECT_MANAGER_MAX_BODY_BYTES,
): Promise<Uint8Array | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maximumBytes) return null;
    chunks.push(bytes);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

/**
 * The credential is admitted from `PROJECT_MANAGER_CREDENTIAL_HEADER` and from nowhere
 * else. A Cookie header is not read at all, so a browser that still holds an old cookie
 * cannot authenticate with it and neither can anything that stole one: node lowercases
 * and joins repeated headers with ", ", which fails the shape check below rather than
 * being silently split.
 */
export function requestHasSession(request: IncomingMessage, expected: string): boolean {
  const presented = request.headers[PROJECT_MANAGER_CREDENTIAL_HEADER];
  if (typeof presented !== "string") return false;
  return isManagerSecret(presented) && secretMatchesConstantTime(presented, expected);
}

function validProjectOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "http:" && url.hostname === "127.0.0.1"
      && url.username === "" && url.password === "" && url.pathname === "/" && url.search === ""
      && url.hash === "" && url.origin === value
      && url.port === String(port) && Number.isInteger(port) && port >= 1 && port <= 65_535
      ;
  } catch { return false; }
}

export function decodeManagerResult(value: unknown, allowOrigin: boolean): ProjectManagerHttpResult | null {
  const base = record(value, ["code", "layer", "ok"]);
  if (allowOrigin && base?.["ok"] === true) return null;
  const opened = allowOrigin && base === null ? record(value, ["code", "layer", "ok", "origin"]) : null;
  const source = base ?? opened;
  if (source === null || typeof source["ok"] !== "boolean"
    || typeof source["code"] !== "string" || !STABLE_NAME.test(source["code"])
    || typeof source["layer"] !== "string" || !STABLE_NAME.test(source["layer"])) return null;
  if (opened !== null) {
    if (source["ok"] !== true || !validProjectOrigin(source["origin"])) return null;
    return Object.freeze({ code: source["code"], layer: source["layer"], ok: true,
      origin: source["origin"] });
  }
  return Object.freeze({ code: source["code"], layer: source["layer"], ok: source["ok"] });
}

function decodeProject(value: unknown): ProjectManagerProject | null {
  const item = record(value, ["instanceId", "lifecycle", "projectId", "root", "title"]);
  if (item === null || !isManagerInstanceId(item["instanceId"])
    || !PROJECT_MANAGER_LIFECYCLES.includes(item["lifecycle"] as ProjectManagerLifecycle)
    || typeof item["projectId"] !== "string" || !IDENTIFIER.test(item["projectId"])
    || !localWindowsPath(item["root"]) || !title(item["title"])) return null;
  return Object.freeze({ instanceId: item["instanceId"], lifecycle: item["lifecycle"] as ProjectManagerLifecycle,
    projectId: item["projectId"], root: item["root"], title: item["title"] });
}

export function decodeManagerList(value: unknown): ProjectManagerProjectList | null {
  const result = record(value, ["projects", "schemaVersion"]);
  const source = result === null ? null : exactArray(result["projects"]);
  if (result === null || result["schemaVersion"] !== PROJECT_MANAGER_PROTOCOL_VERSION
    || source === null) return null;
  const projects: ProjectManagerProject[] = [];
  const ids = new Set<string>();
  for (const valueProject of source) {
    const project = decodeProject(valueProject);
    if (project === null || ids.has(project.instanceId)) return null;
    ids.add(project.instanceId);
    projects.push(project);
  }
  return Object.freeze({ projects: Object.freeze(projects), schemaVersion: PROJECT_MANAGER_PROTOCOL_VERSION });
}
