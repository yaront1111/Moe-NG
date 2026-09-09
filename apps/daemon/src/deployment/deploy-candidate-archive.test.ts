import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  ARCHIVE_BLOCK_BYTES, ARCHIVE_DIRECTORY_MODE, ARCHIVE_FILE_MODE, ARCHIVE_NAME_BYTES,
  ARCHIVE_OWNER_GID, ARCHIVE_OWNER_UID, DEPLOY_ARCHIVE_PATH_INVALID,
  DEPLOY_ARCHIVE_PATH_TOO_LONG, encodeCandidateArchive,
} from "./deploy-candidate-archive.js";
import { CANDIDATE_ENVIRONMENT_PATH, encodeCandidateEnvironment } from "./deploy-candidate-environment.js";
import { DEPLOYMENT_NODE_IMAGE } from "../repository/deployment/deployment-infrastructure-templates.js";

/**
 * THE ENCODER IS PROVEN AGAINST A REAL READER, NEVER AGAINST A DECODER WRITTEN HERE. An encoder
 * and a matching decoder agree on a wrong format all day; `bsdtar` does not. Every structural arm
 * below is paired with a `tar` read-back of the SAME bytes, so a header this file believes is
 * correct is also one a real tar accepts.
 */

/** The bytes the runner's stdin would carry: `child.stdin.write(string)` encodes UTF-8. */
const bytesOf = (archive: string): Buffer => Buffer.from(archive, "utf8");

const encoded = (text: string, path?: string): string => {
  const result = path === undefined ? encodeCandidateArchive(text) : encodeCandidateArchive(text, path);
  if (!result.ok) throw new Error(`encoder refused: ${result.code}`);
  return result.archive;
};

/** Runs the real `tar` over the archive. Absent on a host without it, which the arms assert. */
const readBack = (archive: string, args: readonly string[]): { out: string; status: number | null } => {
  const run = spawnSync("tar", [...args], { input: bytesOf(archive), shell: false });
  return { out: run.stdout?.toString("utf8") ?? "", status: run.status };
};

const VALUE = "delivered-not-a-secret-abc123";
const PAYLOAD = encodeCandidateEnvironment({ SECRET_TOKEN: VALUE });

/** The image the generated Dockerfile pins, and the user its last `USER` line names. */
const DELIVERY_IMAGE = DEPLOYMENT_NODE_IMAGE;
const APP_USER = "node";

const docker = (args: readonly string[], stdin?: string): { out: string; status: number | null } => {
  const run = spawnSync("docker", [...args], {
    input: stdin === undefined ? undefined : bytesOf(stdin), shell: false, timeout: 120_000,
  });
  return { out: run.stdout?.toString("utf8") ?? "", status: run.status };
};

/**
 * Resolved ONCE, at load, and handed to `it.runIf` — so a host without docker REPORTS the arm as
 * skipped instead of passing it vacuously. An `if (...) return` inside the body would count as a
 * pass while asserting nothing, which is the shape that lets a delivery regression ride through a
 * green lane. The image must be present too: a missing image is not a reason to claim the delivery
 * was proven.
 */
const DOCKER_READY = docker(["version", "--format", "{{.Server.Version}}"]).status === 0
  && docker(["image", "inspect", DELIVERY_IMAGE]).status === 0;

describe("the candidate archive is a USTAR stream a real tar accepts", () => {
  it("lists exactly the parent directory and the delivery file, with the app user's ids", () => {
    const listed = readBack(encoded(PAYLOAD), ["-tvf", "-"]);

    expect(listed.status).toBe(0);
    // `tar -tv` prints the NUMERIC ids, which is the field under test. Literal, not the imported
    // constant: a constant on both sides of the assertion moves with the mutation and stays green.
    expect(listed.out).toContain("1000/1000");
    expect(listed.out).toContain("-rw-------");
    expect(listed.out.split(/\r?\n/u).filter((line) => line !== "").map((line) => line.split(" ").pop()))
      .toEqual(["run/moe/", "run/moe/env"]);
  });

  it("returns the payload byte for byte through a real extraction", () => {
    const extracted = readBack(encoded(PAYLOAD), ["-xOf", "-", CANDIDATE_ENVIRONMENT_PATH.slice(1)]);

    expect(extracted.status).toBe(0);
    expect(extracted.out).toBe(PAYLOAD);
  });

  it("sizes a multi-byte value in BYTES, so tar does not read it short", () => {
    // The trap this arm exists for: the size field counts what tar reads off the wire, and one
    // multi-byte character makes `String.length` smaller than `Buffer.byteLength`. A short read is
    // exactly what tar was told to expect, so it reports no error at all for the truncation.
    const multibyte = encodeCandidateEnvironment({ SECRET_TOKEN: "café-éè-中文-\u{1f512}" });
    expect(multibyte.length).toBeLessThan(Buffer.byteLength(multibyte, "utf8"));
    const extracted = readBack(encoded(multibyte), ["-xOf", "-", CANDIDATE_ENVIRONMENT_PATH.slice(1)]);

    expect(extracted.status).toBe(0);
    expect(extracted.out).toBe(multibyte);
  });

  it("encodes an EMPTY payload as a valid archive rather than a malformed one", () => {
    // Unreachable through `candidateEnvironmentPort` today — it answers `source: null` for an
    // environment holding nothing, so nothing is encoded. Pinned anyway because the encoder is a
    // general function the successor row will call, and `padToBlock(0)` is the one arithmetic here
    // that could plausibly emit a stray 512 NULs and desynchronise every reader after it.
    const empty = encoded("");
    expect(bytesOf(empty).length).toBe(ARCHIVE_BLOCK_BYTES * 4);
    expect(readBack(empty, ["-tf", "-"]).status).toBe(0);
    const extracted = readBack(empty, ["-xOf", "-", CANDIDATE_ENVIRONMENT_PATH.slice(1)]);
    expect(extracted.status).toBe(0);
    expect(extracted.out).toBe("");
  });

  it("is a whole number of 512-byte blocks and ends in two zero blocks", () => {
    const bytes = bytesOf(encoded(PAYLOAD));

    expect(bytes.length % ARCHIVE_BLOCK_BYTES).toBe(0);
    expect(bytes.subarray(bytes.length - ARCHIVE_BLOCK_BYTES * 2))
      .toEqual(Buffer.alloc(ARCHIVE_BLOCK_BYTES * 2, 0));
  });

  it.runIf(DOCKER_READY)("is read back by the CONSUMER that matters, at the app user's ownership", () => {
    // `tar` proves the format; only `docker cp` proves the DELIVERY. The container runs as the
    // image's app user, so this asserts the one property a format check cannot see: that the file
    // arrives readable by the process that needs it. `docker cp` gives copied files ROOT ownership
    // unless the USTAR header says otherwise, and a root-owned 0600 file copies with EXIT 0 and is
    // then unreadable — surfacing 150 seconds later as a health timeout naming nothing.
    const name = `moe-archive-arm-${String(process.pid)}`;
    try {
      const created = docker(["create", "--user", APP_USER, "--name", name, DELIVERY_IMAGE,
        "sh", "-c", `ls -ln ${CANDIDATE_ENVIRONMENT_PATH}; cat ${CANDIDATE_ENVIRONMENT_PATH}`]);
      expect(created.status).toBe(0);
      expect(docker(["cp", "-", `${name}:/`], encoded(PAYLOAD)).status).toBe(0);
      const started = docker(["start", "--attach", name]);

      expect(started.status).toBe(0);
      // `ls -ln` prints NUMERIC owner and group. Literal 1000s again, for the same reason.
      expect(started.out).toMatch(/^-rw-------\s+1\s+1000\s+1000\s/mu);
      expect(started.out).toContain(PAYLOAD.trimEnd());
    } finally {
      // Epic rail 4: this container is removed on EVERY exit path, including the failing ones.
      docker(["rm", "--force", name]);
    }
  });

  it("refuses a path it cannot represent instead of truncating it", () => {
    // A truncated path delivers the environment somewhere the loader never reads, which starts a
    // candidate with no variables and no error — the failure a refusal exists to prevent.
    const long = `/run/${"d".repeat(ARCHIVE_NAME_BYTES)}/env`;
    expect(encodeCandidateArchive(PAYLOAD, long)).toEqual({ code: DEPLOY_ARCHIVE_PATH_TOO_LONG, ok: false });
    expect(encodeCandidateArchive(PAYLOAD, "run/moe/env")).toEqual({ code: DEPLOY_ARCHIVE_PATH_INVALID, ok: false });
    expect(encodeCandidateArchive(PAYLOAD, "/env")).toEqual({ code: DEPLOY_ARCHIVE_PATH_INVALID, ok: false });
    // Non-ASCII would shift every field after `name` by a byte, because the header is laid out and
    // checksummed in UTF-16 code units. Refused rather than encoded into an unparseable header.
    expect(encodeCandidateArchive(PAYLOAD, "/run/moé/env")).toEqual({ code: DEPLOY_ARCHIVE_PATH_INVALID, ok: false });
  });

  it("accepts a name at the exact 100-byte limit and refuses the very next byte", () => {
    // The boundary itself, both sides, so an off-by-one in either direction is caught. The arm
    // proves the accepted case really is AT the limit rather than merely under it.
    // `nameOf(n)` builds an absolute path whose TAR-RELATIVE name is exactly n bytes long.
    const nameOf = (length: number): string => `/${"d".repeat(length - 4)}/env`;
    expect(nameOf(ARCHIVE_NAME_BYTES).slice(1).length).toBe(ARCHIVE_NAME_BYTES);
    expect(nameOf(ARCHIVE_NAME_BYTES + 1).slice(1).length).toBe(ARCHIVE_NAME_BYTES + 1);
    const accepted = encodeCandidateArchive(PAYLOAD, nameOf(ARCHIVE_NAME_BYTES));
    expect(accepted.ok).toBe(true);
    expect(encodeCandidateArchive(PAYLOAD, nameOf(ARCHIVE_NAME_BYTES + 1)))
      .toEqual({ code: DEPLOY_ARCHIVE_PATH_TOO_LONG, ok: false });
    // And the accepted one is still readable by a real tar, not merely accepted by this encoder.
    expect(readBack(accepted.ok ? accepted.archive : "", ["-tf", "-"]).status).toBe(0);
  });
});

describe("no header field ever carries a value", () => {
  /** Every 512-byte block that is a HEADER: block 0 and 1 here, and never the payload block. */
  const headerBlocks = (archive: string): Buffer => bytesOf(archive).subarray(0, ARCHIVE_BLOCK_BYTES * 2);

  it("puts the value in the DATA block and in no header byte at all", () => {
    // A long name, a mis-sized field or a value spliced into the wrong offset is exactly how a
    // value bleeds into a header, and `docker inspect` does not have to be involved for it to
    // leak — the archive is the artefact. So the header bytes are swept explicitly.
    const archive = encoded(PAYLOAD);
    const all = bytesOf(archive);

    expect(headerBlocks(archive).includes(VALUE)).toBe(false);
    expect(headerBlocks(archive).includes("SECRET_TOKEN")).toBe(false);
    // ...and the sweep is not vacuous: the value IS in the archive, in the data block only.
    expect(all.includes(VALUE)).toBe(true);
    expect(all.subarray(ARCHIVE_BLOCK_BYTES * 2).includes(VALUE)).toBe(true);
  });

  it("keeps a newline inside the payload rather than letting it reach a header", () => {
    // A newline in a value is the case that would break a line-oriented encoder; USTAR is
    // length-prefixed, so it must simply ride through and still land in the data block only.
    const withNewline = encodeCandidateEnvironment({ SECRET_TOKEN: `one\n${VALUE}\ntwo` });
    const archive = encoded(withNewline);

    expect(headerBlocks(archive).includes(VALUE)).toBe(false);
    expect(readBack(archive, ["-xOf", "-", CANDIDATE_ENVIRONMENT_PATH.slice(1)]).out).toBe(withNewline);
  });

  it("keeps a value far longer than one block out of every header", () => {
    // Multi-block payloads are where a size/padding error shows up: the value spans blocks 2..n
    // and the two zero blocks must still terminate the stream cleanly.
    const long = encodeCandidateEnvironment({ SECRET_TOKEN: VALUE.repeat(400) });
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(ARCHIVE_BLOCK_BYTES * 20);
    const archive = encoded(long);

    expect(headerBlocks(archive).includes(VALUE)).toBe(false);
    const extracted = readBack(archive, ["-xOf", "-", CANDIDATE_ENVIRONMENT_PATH.slice(1)]);
    expect(extracted.status).toBe(0);
    expect(extracted.out).toBe(long);
  });
});

describe("the header checksum is the one a reader recomputes", () => {
  /** USTAR's definition: the sum of every header byte with the checksum field itself read as
   *  eight spaces. Recomputed here from the DELIVERED bytes, not from the encoder's arithmetic. */
  const recompute = (block: Buffer): number => {
    const blanked = Buffer.from(block);
    blanked.fill(0x20, 148, 156);
    return blanked.reduce((sum, byte) => sum + byte, 0);
  };

  it("validates for every header block, against a sum taken off the delivered bytes", () => {
    const bytes = bytesOf(encoded(PAYLOAD));
    let checked = 0;
    for (const at of [0, ARCHIVE_BLOCK_BYTES]) {
      const block = bytes.subarray(at, at + ARCHIVE_BLOCK_BYTES);
      const stored = Number.parseInt(block.subarray(148, 154).toString("ascii"), 8);
      expect(stored).toBe(recompute(block));
      checked += 1;
    }
    // The sweep asserts it actually swept: a loop that produced zero comparisons would pass.
    expect(checked).toBe(2);
  });

  it("carries the ustar magic, the version, and the measured owner ids in both headers", () => {
    // THE NUMBERS ARE LITERALS, NOT THE IMPORTED CONSTANTS. Asserting a delivered field against
    // the very constant that produced it moves both sides together, so flipping the constant
    // leaves the arm green while the delivery changes. These four are the MEASURED values —
    // `id -u node` / `id -g node` on node:24.16.0-alpine, owner-only for the environment file,
    // traversable for its directory — and the constants are pinned to them separately.
    expect([ARCHIVE_OWNER_UID, ARCHIVE_OWNER_GID]).toEqual([1000, 1000]);
    expect([ARCHIVE_FILE_MODE, ARCHIVE_DIRECTORY_MODE]).toEqual([0o600, 0o755]);
    const bytes = bytesOf(encoded(PAYLOAD));
    const field = (at: number, from: number, width: number): string =>
      bytes.subarray(at + from, at + from + width).toString("ascii").replace(/\0.*$/su, "");

    for (const at of [0, ARCHIVE_BLOCK_BYTES]) {
      expect(bytes.subarray(at + 257, at + 265).toString("ascii")).toBe("ustar\x0000");
      expect(Number.parseInt(field(at, 108, 8), 8)).toBe(1000);
      expect(Number.parseInt(field(at, 116, 8), 8)).toBe(1000);
    }
    // Typeflag and mode differ between the two, which is what makes them a directory and a file.
    expect(field(0, 156, 1)).toBe("5");
    expect(Number.parseInt(field(0, 100, 8), 8)).toBe(0o755);
    expect(field(ARCHIVE_BLOCK_BYTES, 156, 1)).toBe("0");
    expect(Number.parseInt(field(ARCHIVE_BLOCK_BYTES, 100, 8), 8)).toBe(0o600);
    // The size field is the UTF-8 BYTE count, which is the field a short read would come from.
    expect(Number.parseInt(field(ARCHIVE_BLOCK_BYTES, 124, 12), 8)).toBe(Buffer.byteLength(PAYLOAD, "utf8"));
  });
});
