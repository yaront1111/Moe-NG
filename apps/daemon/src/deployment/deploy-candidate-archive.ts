import { CANDIDATE_ENVIRONMENT_PATH } from "./deploy-candidate-environment.js";

/**
 * THE ENVIRONMENT AS A TAR ARCHIVE ON DOCKER'S STDIN, so the plaintext never names a path on the
 * docker host. A bind mount's `source` is resolved on the DOCKER host, and for an ssh target that
 * is not the daemon's machine — so a mount cannot deliver remotely at all. `docker cp -` reads a
 * USTAR archive from STDIN, and the runner already carries stdin through `ssh <target> docker ...`,
 * so the same bytes reach a local and a remote target by the same path: host memory -> docker CLI
 * stdin -> container filesystem. Nothing is written to any disk on either machine.
 *
 * THREE THINGS HERE WERE MEASURED AGAINST DOCKER 29.6.2 AND node:24.16.0-alpine, not inferred:
 *  1. THE uid/gid FIELDS ARE LOAD-BEARING. `docker cp - <c>:/` honours the USTAR header's uid and
 *     gid WITHOUT `--archive`. The generated Dockerfile ends `USER node`, and node:24.16.0-alpine
 *     reports `id -u node` = 1000, `id -g node` = 1000. The counterfactual is what proves it: the
 *     identical archive written with uid/gid 0 lands root-owned, and the app user then gets
 *     `cat: can't open '/run/moe/env': Permission denied`. That failure copies with EXIT 0 and
 *     surfaces 150 seconds later as a health timeout naming nothing — so the fields are checked by
 *     an arm, not left to a reviewer's eye. The two escapes from it are both refused by design:
 *     running the container as root, and widening the mode past owner-only.
 *  2. ONLY THE IMMEDIATE PARENT DIRECTORY IS EMITTED. `/run` exists in the image and `/run/moe`
 *     does not. Emitting `run/` too would rewrite an existing system directory's ownership for no
 *     gain; emitting neither also works, because docker creates missing intermediates — but the
 *     shape proven end to end is the one with the leaf's parent present, so that is the one shipped.
 *  3. THE ARCHIVE IS RETURNED AS A STRING BECAUSE THE RUNNER'S STDIN IS ONE. `runProcess` calls
 *     `child.stdin.write(stdin)`, which encodes UTF-8. So every byte this emits outside the payload
 *     is ASCII, and the payload is spliced in AS TEXT — the caller's own string, re-encoded to the
 *     identical bytes it came from. The size field and the padding are therefore computed from
 *     `Buffer.byteLength`, NEVER from `String.length`: a value carrying one multi-byte character
 *     makes those two differ, tar reads exactly the short count it was told to expect, and reports
 *     no error at all for the truncation.
 */

/** USTAR's fixed record size. Every header is one; data is padded up to a multiple of it. */
export const ARCHIVE_BLOCK_BYTES = 512;
/** The app user of `node:24.16.0-alpine`, measured with `id -u node` / `id -g node`. */
export const ARCHIVE_OWNER_UID = 1000;
export const ARCHIVE_OWNER_GID = 1000;
/** Owner-only. The file holds the environment; nothing else in the container may read it. */
export const ARCHIVE_FILE_MODE = 0o600;
/** The parent directory must be traversable, so 0755 — it holds no bytes of its own. */
export const ARCHIVE_DIRECTORY_MODE = 0o755;
/** USTAR's `name` field. A longer path needs the `prefix` field or a GNU extension; refused. */
export const ARCHIVE_NAME_BYTES = 100;
/** The `size` field is 11 octal digits plus a NUL, so 8 GiB minus one byte. */
export const ARCHIVE_MAX_PAYLOAD_BYTES = 8 ** 11 - 1;

/** A path that will not fit USTAR's 100-byte `name` field. Refused, never truncated: a truncated
 *  path delivers the environment somewhere the loader does not read, which starts a candidate with
 *  no variables and no error. */
export const DEPLOY_ARCHIVE_PATH_TOO_LONG = "DEPLOY_ARCHIVE_PATH_TOO_LONG" as const;
/** A path that is not absolute, or that names no file — neither can be encoded as an entry. */
export const DEPLOY_ARCHIVE_PATH_INVALID = "DEPLOY_ARCHIVE_PATH_INVALID" as const;
/** A payload past what the `size` field can express. Refused rather than written short. */
export const DEPLOY_ARCHIVE_PAYLOAD_TOO_LARGE = "DEPLOY_ARCHIVE_PAYLOAD_TOO_LARGE" as const;

export interface CandidateArchiveEncoded {
  /** The whole archive, ready for `docker cp -`'s stdin. UTF-8 round-trips it byte for byte. */
  readonly archive: string;
  readonly ok: true;
}

export interface CandidateArchiveRefused {
  readonly code: string;
  readonly ok: false;
}

export type CandidateArchiveResult = CandidateArchiveEncoded | CandidateArchiveRefused;

/** A USTAR numeric field: octal, zero-padded to one less than the width, then a NUL. */
const octalField = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Pad to `width` with NUL, which is how USTAR fills every field it does not use. */
const padded = (text: string, width: number): string => text.padEnd(width, "\0");

interface HeaderFields {
  readonly mode: number;
  readonly name: string;
  readonly size: number;
  readonly mtime: number;
  readonly typeflag: "0" | "5";
}

/**
 * One 512-byte header. THE CHECKSUM IS COMPUTED OVER THE HEADER WITH ITS OWN FIELD SPACE-FILLED,
 * which is the whole of the USTAR checksum definition and the one part a reader will reject. It is
 * written back as six octal digits, a NUL and a space — GNU tar's form, and the one `bsdtar` and
 * `docker cp` were both measured to accept.
 *
 * `uname` and `gname` are left EMPTY on purpose. A reader that resolves them would prefer the NAME
 * over the numeric id, and the container's passwd is not this encoder's to assume; the measured
 * read-back with both empty gave the intended 1000:1000.
 */
function header(fields: HeaderFields): string {
  const parts = [
    padded(fields.name, ARCHIVE_NAME_BYTES),
    octalField(fields.mode, 8),
    octalField(ARCHIVE_OWNER_UID, 8),
    octalField(ARCHIVE_OWNER_GID, 8),
    octalField(fields.size, 12),
    octalField(fields.mtime, 12),
    "        ", // checksum, space-filled while it is being computed over itself
    fields.typeflag,
    padded("", 100), // linkname
    "ustar\0", "00",
    padded("", 32), padded("", 32), // uname, gname
    padded("", 8), padded("", 8), // devmajor, devminor
    padded("", 155), // prefix
  ].join("");
  const block = padded(parts, ARCHIVE_BLOCK_BYTES);
  let sum = 0;
  for (let at = 0; at < block.length; at += 1) sum += block.charCodeAt(at);
  return `${block.slice(0, 148)}${octalField(sum, 7)} ${block.slice(156)}`;
}

/** NUL blocks to bring `bytes` up to the next 512 boundary. Zero when it is already on one. */
const padToBlock = (bytes: number): string => "\0".repeat((ARCHIVE_BLOCK_BYTES - (bytes % ARCHIVE_BLOCK_BYTES)) % ARCHIVE_BLOCK_BYTES);

/**
 * `/run/moe/env` becomes the tar-relative `run/moe/env` and its parent `run/moe/`.
 *
 * NON-ASCII IS REFUSED RATHER THAN ENCODED. Every header field here is laid out and checksummed in
 * UTF-16 code units, which equal bytes only while the text stays under U+0080; one accented
 * character would silently shift every field after `name` by a byte and produce a header no reader
 * can parse. The delivery path is a module constant today, so this refuses a future caller's
 * mistake rather than a live input.
 */
function entryNames(path: string): { readonly file: string; readonly parent: string } | null {
  if (!path.startsWith("/") || !/^[\x20-\x7e]*$/u.test(path)) return null;
  const relative = path.slice(1);
  const cut = relative.lastIndexOf("/");
  if (cut <= 0 || cut === relative.length - 1) return null;
  return { file: relative, parent: `${relative.slice(0, cut)}/` };
}

/**
 * Encodes the delivery as a single-file USTAR archive: the parent directory entry, the file entry,
 * the payload padded to a block boundary, then the two zero blocks that end every tar stream.
 *
 * `mtime` defaults to 0 so the same environment encodes to the same bytes every time. The delivery
 * is read once at container startup and removed with the deploy, so its timestamp carries nothing;
 * determinism, which lets an arm pin exact bytes, is worth more than a real clock reading here.
 */
export function encodeCandidateArchive(
  text: string, path: string = CANDIDATE_ENVIRONMENT_PATH, mtime = 0,
): CandidateArchiveResult {
  const names = entryNames(path);
  if (names === null) return { code: DEPLOY_ARCHIVE_PATH_INVALID, ok: false };
  if (Buffer.byteLength(names.file, "utf8") > ARCHIVE_NAME_BYTES
    || Buffer.byteLength(names.parent, "utf8") > ARCHIVE_NAME_BYTES) {
    return { code: DEPLOY_ARCHIVE_PATH_TOO_LONG, ok: false };
  }
  // THE BYTE LENGTH, not the string length: the size field counts what tar will read off the wire,
  // and one multi-byte character in a value makes those two numbers different.
  const size = Buffer.byteLength(text, "utf8");
  if (size > ARCHIVE_MAX_PAYLOAD_BYTES) return { code: DEPLOY_ARCHIVE_PAYLOAD_TOO_LARGE, ok: false };
  const archive = [
    header({ mode: ARCHIVE_DIRECTORY_MODE, mtime, name: names.parent, size: 0, typeflag: "5" }),
    header({ mode: ARCHIVE_FILE_MODE, mtime, name: names.file, size, typeflag: "0" }),
    text, padToBlock(size),
    "\0".repeat(ARCHIVE_BLOCK_BYTES * 2),
  ].join("");
  return { archive, ok: true };
}
