import { sep } from "node:path";

export type ControlRoomAssetCode =
  | "LISTENER_ASSET_ENCODING_INVALID"
  | "LISTENER_ASSET_METHOD_INVALID"
  | "LISTENER_ASSET_NOT_FOUND"
  | "LISTENER_ASSET_OUTSIDE_ROOT"
  | "LISTENER_ASSET_PATH_TRAVERSAL"
  | "LISTENER_ASSET_READ_FAILED"
  | "LISTENER_ASSET_ROOT_INVALID"
  | "LISTENER_ASSET_ROOT_LEAKS_SECRET"
  | "LISTENER_ASSET_SEGMENT_INVALID"
  | "LISTENER_ASSET_TOO_LARGE"
  | "LISTENER_ASSET_TYPE_UNKNOWN";

export interface ControlRoomAssetRefusal {
  readonly code: ControlRoomAssetCode;
  readonly detail?: string;
  readonly kind: "LISTENER_REFUSAL";
}

export interface ControlRoomAssetRoot {
  readonly directory: string;
  readonly kind: "ROOT";
}

export interface ControlRoomAssetLocated {
  readonly contentType: string;
  readonly etag: string;
  readonly kind: "ASSET";
  readonly provenPath: string;
  readonly size: number;
}

export type ControlRoomAssetRootResult = ControlRoomAssetRefusal | ControlRoomAssetRoot;
export type ControlRoomAssetDispatch = ControlRoomAssetLocated | ControlRoomAssetRefusal;
export type ControlRoomAssetBytes = ControlRoomAssetRefusal | Uint8Array;

/** Closed publication map: unknown extensions are refused, never guessed. */
export const CONTROL_ROOM_ASSET_CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
} as const);

export const CONTROL_ROOM_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** Applied to every static-route reply, including refusals and 304s. */
export const CONTROL_ROOM_ASSET_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const);

const ASSET_METHODS: readonly string[] = Object.freeze(["GET", "HEAD"]);
const INDEX_DOCUMENT = "index.html";
const ASSET_PATH_MAX_CHARS = 260;
const INVALID_SEGMENT_CHARACTERS = /[\u0000-\u001f<>:"|?*]/u;
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export type PathJudgement =
  | { readonly code: ControlRoomAssetCode }
  | { readonly segments: readonly string[] };

export function refuseAsset(code: ControlRoomAssetCode): ControlRoomAssetRefusal {
  return Object.freeze({ code, kind: "LISTENER_REFUSAL" as const });
}

export function refuseAssetRoot(
  code: ControlRoomAssetCode,
  detail: string,
): ControlRoomAssetRefusal {
  return Object.freeze({ code, detail, kind: "LISTENER_REFUSAL" as const });
}

export function judgeAssetMethod(method: string): ControlRoomAssetRefusal | null {
  return ASSET_METHODS.includes(method) ? null : refuseAsset("LISTENER_ASSET_METHOD_INVALID");
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Decode exactly once; a spelling that changes on a second pass is ambiguous. */
export function decodeRequestPath(raw: string): string | null {
  const once = decodeOnce(raw);
  if (once === null) return null;
  const twice = decodeOnce(once);
  return twice === null || twice !== once ? null : once;
}

function isBoundedPathText(value: string): boolean {
  return value.length <= ASSET_PATH_MAX_CHARS
    && value.isWellFormed()
    && value === value.normalize("NFC");
}

function isUsableSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".."
    || INVALID_SEGMENT_CHARACTERS.test(segment)
    || segment.endsWith(".") || segment.endsWith(" ")) return false;
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/u, "");
  return !RESERVED_DEVICE_NAMES.has(stem.toUpperCase());
}

/** Traversal is graded before platform-specific segment faults. */
export function judgeRequestPath(decoded: string): PathJudgement {
  if (!decoded.startsWith("/") || decoded.includes("\\")) {
    return { code: "LISTENER_ASSET_PATH_TRAVERSAL" };
  }
  if (decoded === "/") return { segments: [INDEX_DOCUMENT] };
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { code: "LISTENER_ASSET_PATH_TRAVERSAL" };
  }
  if (!isBoundedPathText(decoded) || segments.some((segment) => !isUsableSegment(segment))) {
    return { code: "LISTENER_ASSET_SEGMENT_INVALID" };
  }
  return { segments };
}

export function contentTypeFor(segment: string): string | null {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = segment.slice(dot).toLowerCase();
  const types: Readonly<Record<string, string>> = CONTROL_ROOM_ASSET_CONTENT_TYPES;
  return Object.hasOwn(types, extension) ? types[extension] ?? null : null;
}

/** Inputs are canonical realpath spellings; no caller spelling reaches here. */
export function isContainedBy(root: string, resolved: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolved.startsWith(prefix);
}

export interface AssetStatShape {
  readonly mtimeMs: number;
  readonly size: number;
}

export function weakEtagOf(stat: AssetStatShape): string {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

/** RFC 7232 weak comparison for If-None-Match. */
export function assetIsUnchanged(
  located: ControlRoomAssetLocated,
  ifNoneMatch: string | string[] | undefined,
): boolean {
  if (typeof ifNoneMatch !== "string") return false;
  const expected = located.etag.replace(/^W\//u, "");
  for (const candidate of ifNoneMatch.split(",")) {
    const tag = candidate.trim().replace(/^W\//u, "");
    if (tag === "*" || tag === expected) return true;
  }
  return false;
}
