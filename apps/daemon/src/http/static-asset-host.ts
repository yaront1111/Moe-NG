import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import {
  CONTROL_ROOM_ASSET_CONTENT_TYPES,
  CONTROL_ROOM_ASSET_MAX_BYTES,
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  assetIsUnchanged,
  contentTypeFor,
  decodeRequestPath,
  isContainedBy,
  judgeAssetMethod,
  judgeRequestPath,
  refuseAsset,
  refuseAssetRoot,
  weakEtagOf,
} from "./static-asset-path-policy.js";
import type {
  ControlRoomAssetBytes,
  ControlRoomAssetDispatch,
  ControlRoomAssetLocated,
  ControlRoomAssetRoot,
  ControlRoomAssetRootResult,
} from "./static-asset-path-policy.js";

/**
 * Filesystem effects for the static Control Room host. Deterministic request,
 * type, containment and validator policy lives in static-asset-path-policy;
 * this module proves roots and files, then reads only a proven canonical path.
 */
export {
  CONTROL_ROOM_ASSET_CONTENT_TYPES,
  CONTROL_ROOM_ASSET_MAX_BYTES,
  CONTROL_ROOM_ASSET_RESPONSE_HEADERS,
  assetIsUnchanged,
};
export type {
  ControlRoomAssetBytes,
  ControlRoomAssetCode,
  ControlRoomAssetDispatch,
  ControlRoomAssetLocated,
  ControlRoomAssetRefusal,
  ControlRoomAssetRoot,
  ControlRoomAssetRootResult,
} from "./static-asset-path-policy.js";

const INDEX_DOCUMENT = "index.html";
const BAKED_SECRET_MARKERS: readonly string[] = Object.freeze([
  "VITE_MOE_LIVE_CREDENTIAL:",
  "VITE_MOE_LIVE_CSRF:",
]);

function isMissingEntry(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function displayPathOf(root: string, absolute: string): string {
  return `/${absolute.slice(root.length).replaceAll(sep, "/").replace(/^\/+/u, "")}`;
}

function secretSpellings(secret: string): readonly string[] {
  if (secret === "") return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

/** Scan exactly the regular, allowed-type, under-ceiling files this host serves. */
function firstLeakingAsset(
  directory: string,
  secrets: readonly Buffer[],
  root: string,
): string | null {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const found = firstLeakingAsset(absolute, secrets, root);
      if (found !== null) return found;
      continue;
    }
    if (!entry.isFile() || contentTypeFor(entry.name) === null) continue;
    if (statSync(absolute).size > CONTROL_ROOM_ASSET_MAX_BYTES) continue;
    const bytes = readFileSync(absolute);
    if (secrets.some((secret) => bytes.includes(secret))) return displayPathOf(root, absolute);
  }
  return null;
}

/** Resolve and scan the bundle before the listener binds any socket. */
export function resolveControlRoomAssetRoot(
  raw: string,
  secrets: readonly string[],
): ControlRoomAssetRootResult {
  if (raw === "" || !isAbsolute(raw)) {
    return refuseAssetRoot(
      "LISTENER_ASSET_ROOT_INVALID",
      `asset root "${raw}" is not an absolute path`,
    );
  }
  let directory: string;
  try {
    directory = realpathSync.native(raw);
    if (!statSync(directory).isDirectory()) {
      return refuseAssetRoot(
        "LISTENER_ASSET_ROOT_INVALID",
        `asset root "${raw}" is not a directory`,
      );
    }
  } catch {
    return refuseAssetRoot(
      "LISTENER_ASSET_ROOT_INVALID",
      `asset root "${raw}" cannot be resolved`,
    );
  }
  if (!isRegularFile(join(directory, INDEX_DOCUMENT))) {
    return refuseAssetRoot(
      "LISTENER_ASSET_ROOT_INVALID",
      `asset root "${directory}" has no ${INDEX_DOCUMENT}: a control-room bundle carries one at its root`,
    );
  }
  const probes = [...BAKED_SECRET_MARKERS, ...secrets.flatMap(secretSpellings)]
    .map((probe) => Buffer.from(probe, "utf8"));
  let leaking: string | null;
  try {
    leaking = firstLeakingAsset(directory, probes, directory);
  } catch {
    return refuseAssetRoot(
      "LISTENER_ASSET_ROOT_INVALID",
      `asset root "${directory}" could not be scanned`,
    );
  }
  if (leaking !== null) {
    return refuseAssetRoot(
      "LISTENER_ASSET_ROOT_LEAKS_SECRET",
      `${leaking} carries a baked VITE_MOE_LIVE_* value or a secret this daemon holds; `
        + "rebuild the control room without VITE_MOE_LIVE_* set",
    );
  }
  return Object.freeze({ directory, kind: "ROOT" as const });
}

/** Locate in the fixed method/decode/path/type/realpath/containment/stat order. */
export function locateControlRoomAsset(
  root: ControlRoomAssetRoot,
  method: string,
  requestPath: string,
): ControlRoomAssetDispatch {
  const methodRefusal = judgeAssetMethod(method);
  if (methodRefusal !== null) return methodRefusal;

  const decoded = decodeRequestPath(requestPath);
  if (decoded === null) return refuseAsset("LISTENER_ASSET_ENCODING_INVALID");
  const judged = judgeRequestPath(decoded);
  if ("code" in judged) return refuseAsset(judged.code);
  const contentType = contentTypeFor(judged.segments[judged.segments.length - 1] ?? "");
  if (contentType === null) return refuseAsset("LISTENER_ASSET_TYPE_UNKNOWN");

  let resolved: string;
  try {
    resolved = realpathSync.native(join(root.directory, ...judged.segments));
  } catch (cause) {
    return refuseAsset(
      isMissingEntry(cause) ? "LISTENER_ASSET_NOT_FOUND" : "LISTENER_ASSET_READ_FAILED",
    );
  }
  if (!isContainedBy(root.directory, resolved)) {
    return refuseAsset("LISTENER_ASSET_OUTSIDE_ROOT");
  }

  let stat: Stats;
  try {
    stat = statSync(resolved);
  } catch {
    return refuseAsset("LISTENER_ASSET_READ_FAILED");
  }
  if (!stat.isFile()) return refuseAsset("LISTENER_ASSET_NOT_FOUND");
  if (stat.size > CONTROL_ROOM_ASSET_MAX_BYTES) {
    return refuseAsset("LISTENER_ASSET_TOO_LARGE");
  }
  return Object.freeze({
    contentType,
    etag: weakEtagOf(stat),
    kind: "ASSET" as const,
    provenPath: resolved,
    size: stat.size,
  });
}

/** The only byte read: caller-controlled path text is not accepted here. */
export function readControlRoomAssetBytes(located: ControlRoomAssetLocated): ControlRoomAssetBytes {
  try {
    return readFileSync(located.provenPath);
  } catch {
    return refuseAsset("LISTENER_ASSET_READ_FAILED");
  }
}
