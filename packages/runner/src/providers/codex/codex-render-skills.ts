import { isHex64, isNormalizedText, isSafeByteCount, sha256Hex } from "../../canonical.js";
import { codexFailure, type CodexFailure } from "./codex-observation.js";

export const MIRRORED_SKILL_RENDERER_INPUT_VERSION = "moe-skill-renderer-input/1" as const;
export const MAX_MIRRORED_SKILLS = 16;
export const MAX_MIRRORED_SKILL_FILES = 64;

export const CODEX_RENDER_ERROR_CODES = Object.freeze([
  "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN",
  "CODEX_RENDER_CONTEXT_TOO_LARGE",
  "CODEX_RENDER_SKILL_SNAPSHOT_INVALID",
  "CODEX_RENDER_SKILL_SNAPSHOT_LIMIT",
  "CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
  "CODEX_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
  "CODEX_RENDER_TASK_CONTEXT_INVALID",
] as const);
export type CodexRenderErrorCode = (typeof CODEX_RENDER_ERROR_CODES)[number];

export interface MirroredSkillFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentBase64: string;
}

export interface MirroredSkillEntry {
  readonly skillId: string;
  readonly version: string;
  readonly origin: string;
  readonly bundleDigest: string;
  readonly files: readonly MirroredSkillFile[];
}

export interface MirroredSkillRendererInput {
  readonly rendererInputVersion: string;
  readonly authority: "NONE";
  readonly advisoryOnly: true;
  readonly skills: readonly MirroredSkillEntry[];
}

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 400 &&
    isNormalizedText(value);
}

function decodeFile(
  file: MirroredSkillFile,
): Uint8Array | CodexFailure<CodexRenderErrorCode> {
  if (!boundedText(file.path) || typeof file.contentBase64 !== "string") {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_INVALID", "skill file identity is invalid");
  }
  const bytes = new Uint8Array(Buffer.from(file.contentBase64, "base64"));
  if (Buffer.from(bytes).toString("base64") !== file.contentBase64 ||
      !isSafeByteCount(file.byteLength) || bytes.byteLength !== file.byteLength) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_INVALID", `skill file ${file.path} has invalid bytes`);
  }
  if (!isHex64(file.sha256) || sha256Hex(bytes) !== file.sha256) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_INVALID", `skill file ${file.path} digest differs`);
  }
  return bytes;
}

function isFailure(value: unknown): value is CodexFailure<CodexRenderErrorCode> {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function validateSkill(skill: MirroredSkillEntry): CodexFailure<CodexRenderErrorCode> | null {
  if (!boundedText(skill.skillId) || !boundedText(skill.version) || !boundedText(skill.origin) ||
      !isHex64(skill.bundleDigest)) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_INVALID", "skill identity or digest is invalid");
  }
  return null;
}

export function renderAdvisorySkills(
  snapshot: MirroredSkillRendererInput,
): Uint8Array | CodexFailure<CodexRenderErrorCode> {
  if (!Array.isArray(snapshot.skills) || snapshot.skills.length > MAX_MIRRORED_SKILLS) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_LIMIT", "skill count exceeds its limit");
  }
  const skills = [...snapshot.skills].sort((left, right) =>
    left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0);
  const parts: Uint8Array[] = [];
  let fileCount = 0;
  for (const skill of skills) {
    const invalid = validateSkill(skill);
    if (invalid !== null) return invalid;
    if (!Array.isArray(skill.files)) {
      return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_INVALID", "skill files must be an array");
    }
    fileCount += skill.files.length;
    if (fileCount > MAX_MIRRORED_SKILL_FILES) {
      return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_LIMIT", "skill file count exceeds its limit");
    }
    parts.push(encoder.encode(`# skill ${skill.skillId}@${skill.version} authority=NONE\n`));
    const files = [...skill.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    for (const file of files) {
      const bytes = decodeFile(file);
      if (isFailure(bytes)) return bytes;
      parts.push(encoder.encode(`## ${file.path}\n`), bytes, encoder.encode("\n"));
    }
  }
  return concat(parts);
}
