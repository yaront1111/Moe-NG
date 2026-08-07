import { describe, expect, it } from "vitest";

import {
  MAX_SKILL_FILES,
  MAX_SKILL_PATH_CHARS,
  SKILL_MANIFEST_VERSION,
} from "./skill-contract.js";
import { validateSkillManifestBytes } from "./skill-manifest.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

interface ManifestFileShape {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: SKILL_MANIFEST_VERSION,
    skillId: "review-checklist",
    version: "1.4.2",
    origin: "authored",
    files: [{ path: "SKILL.md", sha256: DIGEST_A, byteLength: 12 }],
    ...overrides,
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function fileEntry(overrides: Partial<ManifestFileShape> = {}): ManifestFileShape {
  return { path: "SKILL.md", sha256: DIGEST_A, byteLength: 12, ...overrides };
}

/** Every rejection is the same frozen shape; assert code and immutability together. */
function expectRejection(input: Uint8Array, code: string): string {
  const result = validateSkillManifestBytes(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.code).toBe(code);
  expect(Object.isFrozen(result)).toBe(true);
  return result.message;
}

describe("skill manifest closed schema", () => {
  it("accepts a well-formed manifest and deep-freezes the canonical result", () => {
    const result = validateSkillManifestBytes(bytes(manifest()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.manifest.skillId).toBe("review-checklist");
    expect(result.manifest.files).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.files)).toBe(true);
    expect(Object.isFrozen(result.manifest.files[0])).toBe(true);
    expect(result.identityDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an unknown top-level key", () => {
    expectRejection(bytes(manifest({ grantsAuthority: true })), "SKILL_MANIFEST_SCHEMA_INVALID");
  });

  it("rejects an unknown per-file key", () => {
    const files = [{ ...fileEntry(), executable: true }];
    expectRejection(bytes(manifest({ files })), "SKILL_MANIFEST_SCHEMA_INVALID");
  });

  it("rejects a missing required key", () => {
    const partial = manifest();
    delete partial.version;
    expectRejection(bytes(partial), "SKILL_MANIFEST_SCHEMA_INVALID");
  });

  it("rejects an unsupported manifest version", () => {
    expectRejection(
      bytes(manifest({ manifestVersion: "moe-skill-manifest/2" })),
      "SKILL_MANIFEST_VERSION_UNSUPPORTED",
    );
  });

  it("rejects a non-object manifest body", () => {
    expectRejection(bytes([1, 2, 3]), "SKILL_MANIFEST_SCHEMA_INVALID");
  });
});

describe("skill manifest bounded-decode mapping", () => {
  it("maps invalid UTF-8 to SKILL_UNICODE_INVALID and preserves the inner code", () => {
    const message = expectRejection(new Uint8Array([0x7b, 0xff, 0xfe]), "SKILL_UNICODE_INVALID");
    expect(message).toContain("JSON_UTF8_INVALID");
  });

  it("maps a lone surrogate to SKILL_UNICODE_INVALID", () => {
    const raw = new TextEncoder().encode('{"manifestVersion":"\\ud800"}');
    expectRejection(raw, "SKILL_UNICODE_INVALID");
  });

  it("maps malformed JSON syntax to SKILL_MANIFEST_BYTES_INVALID", () => {
    const message = expectRejection(new TextEncoder().encode("{"), "SKILL_MANIFEST_BYTES_INVALID");
    expect(message).toContain("JSON_SYNTAX_INVALID");
  });

  it("maps a duplicate JSON key to SKILL_MANIFEST_BYTES_INVALID", () => {
    const raw = new TextEncoder().encode('{"skillId":"a","skillId":"b"}');
    expectRejection(raw, "SKILL_MANIFEST_BYTES_INVALID");
  });

  it("maps a non-byte-array input to SKILL_MANIFEST_BYTES_INVALID", () => {
    const result = validateSkillManifestBytes("not bytes" as unknown as Uint8Array);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("SKILL_MANIFEST_BYTES_INVALID");
  });

  it("maps an over-deep body to SKILL_LIMIT_EXCEEDED", () => {
    const deep = `${"[".repeat(300)}1${"]".repeat(300)}`;
    expectRejection(new TextEncoder().encode(deep), "SKILL_LIMIT_EXCEEDED");
  });
});

describe("skill manifest identity", () => {
  it.each([
    ["Review-Checklist", "uppercase"],
    ["-leading-hyphen", "leading hyphen"],
    ["has_underscore", "underscore"],
    ["", "empty"],
    ["a".repeat(65), "over the id length cap"],
  ])("rejects skillId %s (%s)", (skillId) => {
    expectRejection(bytes(manifest({ skillId })), "SKILL_IDENTITY_INVALID");
  });

  it.each([
    [DIGEST_A.toUpperCase(), "uppercase hex"],
    [`${DIGEST_A}a`, "65 characters"],
    ["z".repeat(64), "non-hex characters"],
  ])("rejects file digest %s (%s)", (sha256) => {
    expectRejection(bytes(manifest({ files: [fileEntry({ sha256 })] })), "SKILL_IDENTITY_INVALID");
  });

  it("rejects an empty version", () => {
    expectRejection(bytes(manifest({ version: "" })), "SKILL_IDENTITY_INVALID");
  });

  it("rejects an unknown origin label", () => {
    expectRejection(bytes(manifest({ origin: "trusted" })), "SKILL_IDENTITY_INVALID");
  });

  it("rejects duplicate file paths", () => {
    const files = [fileEntry(), fileEntry({ sha256: DIGEST_B })];
    expectRejection(bytes(manifest({ files })), "SKILL_IDENTITY_DUPLICATE");
  });
});

describe("skill manifest path hardening", () => {
  it.each([
    ["/etc/passwd", "absolute posix"],
    ["C:/skills/a.md", "drive letter"],
    ["docs\\a.md", "backslash separator"],
    ["../a.md", "parent traversal"],
    ["docs/../a.md", "embedded traversal"],
    ["./a.md", "dot segment"],
    ["docs//a.md", "empty segment"],
    ["", "empty path"],
    ["a.md:stream", "NTFS alternate data stream"],
    ["CON.md", "reserved device stem"],
    ["docs/nul.txt", "reserved device stem in a segment"],
    ["COM1.md", "reserved COM device"],
    ["LPT9.md", "reserved LPT device"],
    ["a.md.", "trailing dot"],
    ["a.md ", "trailing space"],
    ["PROGRA~1/a.md", "8.3 alias tilde"],
    ["cafe\u0301.md", "non-NFC Unicode"],
  ])("rejects path %s (%s)", (path) => {
    expectRejection(bytes(manifest({ files: [fileEntry({ path })] })), "SKILL_PATH_INVALID");
  });

  it("rejects a path over the character cap", () => {
    const path = `${"d".repeat(MAX_SKILL_PATH_CHARS)}.md`;
    expectRejection(bytes(manifest({ files: [fileEntry({ path })] })), "SKILL_PATH_INVALID");
  });

  it("accepts a nested NFC path within the caps", () => {
    const files = [fileEntry({ path: "docs/caf\u00e9/guide.md" })];
    const result = validateSkillManifestBytes(bytes(manifest({ files })));
    expect(result.ok).toBe(true);
  });

  it("rejects a case-insensitive path collision", () => {
    const files = [fileEntry({ path: "a.md" }), fileEntry({ path: "A.md", sha256: DIGEST_B })];
    expectRejection(bytes(manifest({ files })), "SKILL_PATH_AMBIGUOUS");
  });
});

describe("skill manifest limits", () => {
  it("rejects more files than the cap", () => {
    const files = Array.from({ length: MAX_SKILL_FILES + 1 }, (_unused, index) =>
      fileEntry({ path: `docs/file-${index}.md` }),
    );
    expectRejection(bytes(manifest({ files })), "SKILL_LIMIT_EXCEEDED");
  });

  it("rejects an empty file list", () => {
    expectRejection(bytes(manifest({ files: [] })), "SKILL_LIMIT_EXCEEDED");
  });

  it.each([
    [-1, "negative"],
    [1.5, "fractional"],
    [262145, "over the per-file byte cap"],
  ])("rejects byteLength %s (%s)", (byteLength) => {
    expectRejection(
      bytes(manifest({ files: [fileEntry({ byteLength })] })),
      "SKILL_LIMIT_EXCEEDED",
    );
  });

  it("rejects a declared total over the bundle byte cap", () => {
    const files = Array.from({ length: 8 }, (_unused, index) =>
      fileEntry({ path: `docs/file-${index}.md`, byteLength: 200_000 }),
    );
    expectRejection(bytes(manifest({ files })), "SKILL_LIMIT_EXCEEDED");
  });

  it("accepts a zero-length declared file", () => {
    const result = validateSkillManifestBytes(
      bytes(manifest({ files: [fileEntry({ byteLength: 0 })] })),
    );
    expect(result.ok).toBe(true);
  });
});

describe("skill manifest canonical identity", () => {
  it("derives the same identity digest regardless of key order", () => {
    const ordered = validateSkillManifestBytes(bytes(manifest()));
    const shuffled = validateSkillManifestBytes(
      bytes({
        files: [{ byteLength: 12, sha256: DIGEST_A, path: "SKILL.md" }],
        origin: "authored",
        version: "1.4.2",
        skillId: "review-checklist",
        manifestVersion: SKILL_MANIFEST_VERSION,
      }),
    );
    expect(ordered.ok && shuffled.ok).toBe(true);
    if (!ordered.ok || !shuffled.ok) throw new Error("expected both to validate");
    expect(shuffled.identityDigest).toBe(ordered.identityDigest);
    expect(shuffled.canonicalJson).toBe(ordered.canonicalJson);
  });

  it("derives a different identity digest when content changes", () => {
    const base = validateSkillManifestBytes(bytes(manifest()));
    const changed = validateSkillManifestBytes(
      bytes(manifest({ files: [fileEntry({ sha256: DIGEST_B })] })),
    );
    expect(base.ok && changed.ok).toBe(true);
    if (!base.ok || !changed.ok) throw new Error("expected both to validate");
    expect(changed.identityDigest).not.toBe(base.identityDigest);
  });
});
