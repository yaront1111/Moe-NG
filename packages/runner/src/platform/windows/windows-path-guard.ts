import { isNormalizedText } from "../../canonical.js";

/**
 * The text and path predicates the launch request is judged by.
 *
 * Split out of `windows-launch-request.ts` because these are the rules a path
 * has to satisfy, not the shape a request has to have. Keeping them here means
 * a second caller can reuse the path rule without also inheriting the request
 * vocabulary.
 */

/** `CreateProcessW`'s classic path bound. A caller needing more must say so. */
export const WINDOWS_MAX_PATH_CHARS = 260;

/**
 * NUL is refused explicitly rather than left to the encoder: every Win32 string
 * this eventually reaches is NUL-terminated, so an embedded NUL truncates the
 * value AFTER validation has approved the whole of it. That is how a validated
 * path becomes a different path.
 */
const NUL = String.fromCharCode(0);

/** Bounded, well-formed (no lone surrogate), NFC, and free of NUL. */
export function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxChars &&
    !value.includes(NUL) &&
    isNormalizedText(value)
  );
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:\\/u;

/**
 * MS-DOS device names. These resolve to a DEVICE from any directory, so
 * `C:\Windows\NUL` is not a file path even though it parses as one.
 */
const RESERVED_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
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
 * A local, drive-absolute path with no traversal and no device.
 *
 * UNC (`\\server\share`), both device namespaces (`\\?\`, `\\.\`) and rooted
 * paths with no drive all fail `DRIVE_ABSOLUTE`, because each begins with a
 * backslash rather than a drive letter. Forward slashes are refused rather than
 * normalised: Windows would accept them, but two spellings of one path make any
 * later equality check a coin flip, and a caller can normalise before asking.
 */
export function isLocalAbsolutePath(value: unknown): value is string {
  if (!isBoundedText(value, WINDOWS_MAX_PATH_CHARS) || value.length === 0) {
    return false;
  }
  if (!DRIVE_ABSOLUTE.test(value) || value.includes("/")) {
    return false;
  }
  return value
    .slice(3)
    .split("\\")
    .every((segment) => isUsableSegment(segment));
}

/**
 * A device name is reserved WITH or WITHOUT an extension — `NUL` and `NUL.txt`
 * are both the device — so the stem is compared, not the whole segment. It is
 * compared by EQUALITY and not by substring, or `CONSOLE.EXE` would be refused
 * for containing `CON`.
 */
function isUsableSegment(segment: string): boolean {
  if (segment === "." || segment === "..") {
    return false;
  }
  const stem = segment.split(".")[0] ?? "";
  return !RESERVED_DEVICE_NAMES.has(stem.toUpperCase());
}
