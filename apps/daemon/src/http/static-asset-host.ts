import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

/**
 * The built control room, served from the daemon's OWN origin.
 *
 * A request path is caller-supplied text that has to become a filesystem path,
 * which is the one place on this transport where "nearly right" is an escape.
 * So the order is fixed and the whole module obeys it: decode first, judge the
 * decoded TEXT second, resolve third, and PROVE containment before a single
 * byte is opened. The read then targets the proven path, never the caller's
 * spelling of it - by construction: `readControlRoomAssetBytes` accepts only
 * the located record, which carries the proven path and nothing the caller
 * wrote. Nothing here throws at a caller: every refusal is a code from the
 * listener's closed roster.
 *
 * WHAT THE ROOT MUST BE. Not any directory: a BUNDLE, proven at start by an
 * `index.html` that is a regular file directly in the root. Without that clause
 * a repository root, a volume root or an empty directory hosts happily, and the
 * closed type map is then the only thing between the route and whatever lives
 * there. The map is closed on purpose and carries exactly what the Vite build
 * emits today (`.html`, hashed `.js` and `.css`) plus an icon, an image and a
 * webfont; `.json` and `.map` are NOT in it because the built bundle emits
 * neither, and `.json` is the extension that turns a mis-set root into a
 * board-state leak (`.moe/project.json`). Add a type the day the build emits it.
 *
 * INTERIM SECRET GUARD, and why it exists. The control room's live attachment
 * reads `VITE_MOE_LIVE_CREDENTIAL` and `VITE_MOE_LIVE_CSRF` at BUILD time, so a
 * bundle that can attach to this daemon carries the daemon's session credential
 * and CSRF token as plain string literals in `assets/index-*.js`. This route
 * answers a bare GET with Host and nothing else - it must, a navigation carries
 * nothing more - so a loopback host that served such a bundle would hand both
 * secrets to every loopback process: another OS account, a WSL or container
 * process, a malicious postinstall, and the agent workers this very daemon
 * spawns. The structural fix (a runtime handshake, no secret baked in) belongs
 * to the control-room rebuild. Until it lands, the start REFUSES to host a root
 * in which any servable file contains a secret this process holds, naming the
 * file by its request path and never echoing the secret. A clean bundle starts.
 */

/** Every refusal this host can emit, all of them members of the listener roster. */
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
  /**
   * A START refusal's operator-facing reason - the path that failed, by
   * request-path spelling, never a secret and never a request refusal's. Absent
   * on every per-request refusal, so nothing here ever reaches the wire.
   */
  readonly detail?: string;
  readonly kind: "LISTENER_REFUSAL";
}

/** The proof object: a root that exists, is a bundle, and was realpath'd ONCE. */
export interface ControlRoomAssetRoot {
  readonly directory: string;
  readonly kind: "ROOT";
}

/**
 * A located asset: proven, typed and MEASURED, not yet read. HEAD and a
 * conditional GET are answered from this record alone; only an unconditional
 * GET goes on to `readControlRoomAssetBytes`, so a request that sends no body
 * never costs a file read.
 */
export interface ControlRoomAssetLocated {
  readonly contentType: string;
  /** Weak validator over size and mtime: cheap, stat-derived, honest about edits. */
  readonly etag: string;
  readonly kind: "ASSET";
  /** `realpathSync.native` output that passed containment: the only path a read targets. */
  readonly provenPath: string;
  readonly size: number;
}

export type ControlRoomAssetRootResult = ControlRoomAssetRefusal | ControlRoomAssetRoot;
export type ControlRoomAssetDispatch = ControlRoomAssetLocated | ControlRoomAssetRefusal;
export type ControlRoomAssetBytes = ControlRoomAssetRefusal | Uint8Array;

/**
 * CLOSED, keyed on the extension alone. An extension absent from here is
 * REFUSED, never served as `application/octet-stream`: guessing a type for an
 * unknown file is how a host ends up serving something it was never built to
 * publish. The type is never inferred from the bytes, and the listener sends
 * `nosniff` so the browser may not re-derive one either. See the module header
 * for why `.json` and `.map` are deliberately absent.
 */
export const CONTROL_ROOM_ASSET_CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
} as const);

/**
 * The ceiling on one served file, refused as `LISTENER_ASSET_TOO_LARGE` above
 * it. Reads here are synchronous and every request re-reads its file, so a file
 * size is a per-request cost on the event loop that also serves the event
 * store; a root is only ever a bundle, and the shipped one's largest file is
 * under 350 KiB, so this is a ceiling for a bundle that grows a source map or a
 * webfont, not a budget. A file above it is never read - not on GET, not on
 * HEAD, and not by the start-time secret scan, which covers exactly the set
 * this host can serve.
 */
export const CONTROL_ROOM_ASSET_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Sent on EVERY reply the static route writes - success, 304 and refusal alike -
 * because the hosted control room is same-origin with `/command`. `frame-ancestors
 * 'none'` and `x-frame-options: DENY` together stop any page from framing the
 * board and clickjacking an operator into a control whose own requests would
 * satisfy the Origin and CSRF gates. `cross-origin-resource-policy: same-origin`
 * stops a `<script src>` / `<link rel=preload>` probe from another origin from
 * loading these bytes, which is what made the route a daemon-present oracle.
 * `referrer-policy: no-referrer` keeps the daemon's origin out of anything the
 * board might link to. The CSP's `default-src 'self'` covers what the built
 * bundle needs: one same-origin script, one same-origin stylesheet, same-origin
 * fetches and system font stacks. React's bounded visual state uses style
 * attributes for progress widths, status colors and timing, so `style-src`
 * admits inline style only. `script-src` remains explicitly same-origin and
 * never admits inline script. `cache-control: no-cache`
 * makes the ETag meaningful: every load revalidates and gets a 304 when the
 * bundle is unchanged, and a redeploy is never served stale.
 */
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

/** Read-only by construction: an asset host answers GET and HEAD or nothing. */
const ASSET_METHODS: readonly string[] = Object.freeze(["GET", "HEAD"]);

/** `/` is the bundle's entry document. There is no other directory index. */
const INDEX_DOCUMENT = "index.html";

/**
 * `CreateProcessW`'s classic bound, mirrored from `WINDOWS_MAX_PATH_CHARS`. The
 * request path is bounded on its own so an over-long spelling is refused as text
 * rather than reaching the filesystem as an ENAMETOOLONG.
 */
const ASSET_PATH_MAX_CHARS = 260;

/**
 * MIRRORED from `packages/runner/src/platform/windows/windows-path-guard.ts`,
 * not imported: `@moe/runner` publishes only `.` and does not re-export that
 * module, and widening another package's surface is not this transport's call.
 * The rules below are the shipped ones character for character - the same
 * reserved set, the same invalid-character class, the same trailing dot and
 * trailing space refusals, and the same trailing-space stem rule that
 * `RtlIsDosDeviceName_U` applies, so `CON .js` is the device too. A looser copy
 * would be a second guard disagreeing with the first, so the cases pin every
 * clause rather than sampling it.
 */
const INVALID_SEGMENT_CHARACTERS = /[\u0000-\u001f<>:"|?*]/u;

const RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * A device name is reserved WITH or WITHOUT an extension, so the STEM is
 * compared, by equality rather than substring - `CONSOLE.EXE` is a file. The
 * stem's trailing U+0020 runs are dropped first because Windows drops them; no
 * other whitespace is, because every control character was already refused and
 * a non-ASCII space is a real character to Windows.
 */
function isUsableSegment(segment: string): boolean {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    INVALID_SEGMENT_CHARACTERS.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  ) {
    return false;
  }
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/u, "");
  return !RESERVED_DEVICE_NAMES.has(stem.toUpperCase());
}

/**
 * The text half of the mirrored guard: bounded, well-formed, NFC. Each clause
 * refuses a spelling the filesystem would otherwise answer for under a name the
 * caller did not write: an over-long path becomes an ENAMETOOLONG (or, behind
 * libuv's `\\?\` prefix, a lookup the bound was meant to forbid), a lone
 * surrogate is not a name at all, and an NFD spelling of an NFC name is a
 * different file on NTFS and the same file on a normalising volume.
 */
function isBoundedPathText(value: string): boolean {
  return (
    value.length <= ASSET_PATH_MAX_CHARS &&
    value.isWellFormed() &&
    value === value.normalize("NFC")
  );
}

function refuse(code: ControlRoomAssetCode): ControlRoomAssetRefusal {
  return Object.freeze({ code, kind: "LISTENER_REFUSAL" as const });
}

function refuseRoot(code: ControlRoomAssetCode, detail: string): ControlRoomAssetRefusal {
  return Object.freeze({ code, detail, kind: "LISTENER_REFUSAL" as const });
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Decoded BEFORE anything is judged, because `%2e%2e` is `..` and a guard that
 * reads the raw spelling never sees it. Decoded a SECOND time and compared,
 * because `%252e%252e` decodes to `%2e%2e`, which is still an escape and still
 * spells `..`: a path that decodes DIFFERENTLY the second time is refused
 * outright rather than normalised, since no single reading of it is the
 * caller's. A path with no escapes at all survives both passes unchanged.
 */
function decodeRequestPath(raw: string): string | null {
  const once = decodeOnce(raw);
  if (once === null) return null;
  const twice = decodeOnce(once);
  if (twice === null || twice !== once) return null;
  return once;
}

type PathJudgement =
  | { readonly code: ControlRoomAssetCode }
  | { readonly segments: readonly string[] };

/**
 * Turns a decoded request path into the segments it may name, or the code that
 * refuses it. Traversal and separator spellings answer first because they are
 * the ones that change WHICH directory is addressed; the per-segment Windows
 * rule answers second because it decides whether a name is a file at all.
 */
function judgeRequestPath(decoded: string): PathJudgement {
  // A target that does not begin with `/` is an absolute or UNC spelling
  // (`C:\...`, `\\server\share`) rather than a path under this root, and a
  // backslash anywhere is the same claim written as a separator Windows honours.
  if (!decoded.startsWith("/") || decoded.includes("\\")) {
    return { code: "LISTENER_ASSET_PATH_TRAVERSAL" };
  }
  if (decoded === "/") return { segments: [INDEX_DOCUMENT] };

  const segments = decoded.slice(1).split("/");
  for (const segment of segments) {
    // The empty segment covers `//server/share`, `/a//b` and a trailing slash:
    // all three are directory claims this host does not answer.
    if (segment === "" || segment === "." || segment === "..") {
      return { code: "LISTENER_ASSET_PATH_TRAVERSAL" };
    }
  }
  if (!isBoundedPathText(decoded)) return { code: "LISTENER_ASSET_SEGMENT_INVALID" };
  for (const segment of segments) {
    // Refuses a reserved device (`NUL.js`, `CON .js`), an NTFS alternate data
    // stream (`index.js:secret`), a control character and a trailing dot or
    // space - every one of which names something other than the file it reads as.
    if (!isUsableSegment(segment)) return { code: "LISTENER_ASSET_SEGMENT_INVALID" };
  }
  return { segments };
}

function contentTypeFor(segment: string): string | null {
  const dot = segment.lastIndexOf(".");
  // `dot <= 0` covers both an extensionless name and a leading-dot name: neither
  // carries an extension this closed map can answer for.
  if (dot <= 0) return null;
  const extension = segment.slice(dot).toLowerCase();
  const types: Readonly<Record<string, string>> = CONTROL_ROOM_ASSET_CONTENT_TYPES;
  return Object.hasOwn(types, extension) ? types[extension] ?? null : null;
}

/**
 * Containment as a PREFIX of the resolved root, both sides being
 * `realpathSync.native` output so the comparison is between two canonical
 * spellings - on Windows that also settles casing and 8.3 short names, which a
 * string compare of the caller's spelling never could.
 */
function isContainedBy(root: string, resolved: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return resolved.startsWith(prefix);
}

function isMissingEntry(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

/**
 * A WEAK validator (RFC 7232): size and mtime say "unchanged" well enough for a
 * bundle that is only ever replaced by a rebuild, and they cost one stat rather
 * than a read. Hex, so the tag stays short and opaque.
 */
function weakEtagOf(stat: Stats): string {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

/**
 * The If-None-Match comparison, WEAK on both sides as RFC 7232 section 3.2
 * requires for that header: `W/` prefixes are ignored, `*` matches anything,
 * and the list form is split on commas. A header this host did not understand
 * matches nothing, so the answer is a full 200 rather than a wrong 304.
 */
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

/**
 * The request-path spelling of a file under the root, for a start-refusal
 * detail: forward slashes, leading `/`, relative to the root. Never the absolute
 * path (the operator supplied that) and never the bytes.
 */
function displayPathOf(root: string, absolute: string): string {
  return `/${absolute.slice(root.length).replaceAll(sep, "/").replace(/^\/+/u, "")}`;
}

/**
 * Walks the root for the file that would leak. SERVABLE means what this host can
 * actually serve: a regular file, reached without following a link (a link's
 * target fails containment at request time), with an extension in the closed
 * map and a size under the ceiling. Files outside that set are never scanned
 * because they are never served. Empty secrets are dropped before the walk: an
 * empty string is a substring of every file, and refusing every root would be a
 * guard nobody could run. A walk that cannot complete is a root that cannot be
 * proven clean, and the caller refuses the start on it.
 */
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

/**
 * Resolved ONCE, by the caller, before anything binds. A root that is relative,
 * absent, unreadable or not a directory is a reason not to serve rather than a
 * reason to fall back: there is no default root anywhere in this module. Then
 * the two bundle clauses from the header, in order: it must carry an
 * `index.html` as a regular file directly under it, and no servable file in it
 * may contain one of `secrets` - the in-process values the caller knows a
 * hosted bundle must never carry. Every refusal names what failed by path, so
 * an operator can fix the root, and never by value, so a log cannot leak.
 */
export function resolveControlRoomAssetRoot(
  raw: string,
  secrets: readonly string[],
): ControlRoomAssetRootResult {
  if (raw === "" || !isAbsolute(raw)) {
    return refuseRoot("LISTENER_ASSET_ROOT_INVALID", `asset root "${raw}" is not an absolute path`);
  }
  let directory: string;
  try {
    directory = realpathSync.native(raw);
    if (!statSync(directory).isDirectory()) {
      return refuseRoot("LISTENER_ASSET_ROOT_INVALID", `asset root "${raw}" is not a directory`);
    }
  } catch {
    return refuseRoot("LISTENER_ASSET_ROOT_INVALID", `asset root "${raw}" cannot be resolved`);
  }
  if (!isRegularFile(join(directory, INDEX_DOCUMENT))) {
    return refuseRoot(
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
    return refuseRoot("LISTENER_ASSET_ROOT_INVALID", `asset root "${directory}" could not be scanned`);
  }
  if (leaking !== null) {
    return refuseRoot(
      "LISTENER_ASSET_ROOT_LEAKS_SECRET",
      `${leaking} carries a baked VITE_MOE_LIVE_* value or a secret this daemon holds; `
        + "rebuild the control room without VITE_MOE_LIVE_* set",
    );
  }
  return Object.freeze({ directory, kind: "ROOT" as const });
}

/**
 * The build-time keys a Vite bundle carries ONLY when the env was set: a clean
 * build emits no such key at all, so the marker has no honest false positive,
 * while a bundle baked for a DIFFERENT daemon - whose secret this process
 * cannot know - still names itself by the key. That closes the gap a scan over
 * this process's own values leaves open.
 */
const BAKED_SECRET_MARKERS: readonly string[] = Object.freeze([
  "VITE_MOE_LIVE_CREDENTIAL:",
  "VITE_MOE_LIVE_CSRF:",
]);

/**
 * Every spelling a minifier gives a string literal: verbatim, and the
 * JSON-escaped form in which a backslash, a quote or a line separator lands in
 * the emitted source. A plain-byte scan over the verbatim value alone is blind
 * exactly when the secret contains one of those. The empty string is dropped:
 * it is a substring of every file, and a guard nobody can run is no guard.
 */
function secretSpellings(secret: string): readonly string[] {
  if (secret === "") return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Everything up to, and not including, the read, in the committed order. The
 * content type is settled BEFORE the filesystem is touched, so an unserveable
 * extension never becomes an existence oracle for paths this host would refuse
 * to publish anyway. The record that comes back is measured from ONE stat of
 * the proven path: the length a HEAD reports, the validator a conditional GET
 * compares and the ceiling check all read the same numbers.
 */
export function locateControlRoomAsset(
  root: ControlRoomAssetRoot,
  method: string,
  requestPath: string,
): ControlRoomAssetDispatch {
  if (!ASSET_METHODS.includes(method)) return refuse("LISTENER_ASSET_METHOD_INVALID");

  const decoded = decodeRequestPath(requestPath);
  if (decoded === null) return refuse("LISTENER_ASSET_ENCODING_INVALID");

  const judged = judgeRequestPath(decoded);
  if ("code" in judged) return refuse(judged.code);

  const contentType = contentTypeFor(judged.segments[judged.segments.length - 1] ?? "");
  if (contentType === null) return refuse("LISTENER_ASSET_TYPE_UNKNOWN");

  let resolved: string;
  try {
    // The link chain is walked HERE, so a symlink or junction planted inside the
    // root resolves to its real target and fails the containment test below
    // instead of being read through.
    resolved = realpathSync.native(join(root.directory, ...judged.segments));
  } catch (cause) {
    return refuse(isMissingEntry(cause) ? "LISTENER_ASSET_NOT_FOUND" : "LISTENER_ASSET_READ_FAILED");
  }
  if (!isContainedBy(root.directory, resolved)) return refuse("LISTENER_ASSET_OUTSIDE_ROOT");

  let stat: Stats;
  try {
    stat = statSync(resolved);
  } catch {
    return refuse("LISTENER_ASSET_READ_FAILED");
  }
  // A directory, a device or anything else that is not a regular file is not an
  // asset. The ceiling answers before any read, for HEAD exactly as for GET, so a
  // file above it costs one stat however it is asked for.
  if (!stat.isFile()) return refuse("LISTENER_ASSET_NOT_FOUND");
  if (stat.size > CONTROL_ROOM_ASSET_MAX_BYTES) return refuse("LISTENER_ASSET_TOO_LARGE");
  return Object.freeze({
    contentType,
    etag: weakEtagOf(stat),
    kind: "ASSET" as const,
    provenPath: resolved,
    size: stat.size,
  });
}

/**
 * The read, and only the read. It takes the LOCATED record and nothing else, so
 * the caller's spelling is not in scope here at all: the bytes that leave are
 * the bytes containment was proven for, whatever alias, casing or short name
 * the request used to reach them.
 */
export function readControlRoomAssetBytes(located: ControlRoomAssetLocated): ControlRoomAssetBytes {
  try {
    return readFileSync(located.provenPath);
  } catch {
    return refuse("LISTENER_ASSET_READ_FAILED");
  }
}
