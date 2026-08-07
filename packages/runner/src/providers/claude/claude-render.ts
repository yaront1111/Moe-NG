import { canonicalDigest, deepFreeze, isHex64, isSafeByteCount, sha256Hex } from "../../canonical.js";
import { claudeFailure, type ClaudeFailure } from "./claude-observation.js";
import type { ClaudeContextLimit } from "./claude-capabilities.js";

/**
 * Deterministic provider-input render for the Claude adapter.
 *
 * ## Advisory text can never become authority
 *
 * Everything rendered here is content handed to a provider. The output type has
 * no command, effect, lease, or approval field — not "must not be set", but no
 * field to set — and every layer carries `authority: "NONE"`. A skill snapshot
 * that claims otherwise is refused rather than sanitised, because a snapshot
 * asserting authority is a snapshot we do not understand.
 *
 * ## The skill snapshot is mirrored, not imported
 *
 * `@moe/skills` is not a dependency of this package: adding one would touch
 * `packages/runner/package.json`, outside this task's owned paths, and would
 * make runner the first dependent of a package it only needs a shape from. The
 * mirror below is structural and pins the version literal, so a snapshot
 * produced by a different renderer-input version is refused instead of being
 * read with the wrong field meanings.
 */
export const CLAUDE_RENDERER_ENVELOPE_VERSION = "moe-claude-renderer-envelope/1" as const;

/** Mirrors `SKILL_RENDERER_INPUT_VERSION` from @moe/skills. */
export const MIRRORED_SKILL_RENDERER_INPUT_VERSION = "moe-skill-renderer-input/1" as const;

/**
 * The design names canonical project instructions, task context, and advisory
 * skills, and defines no richer precedence vocabulary. Inventing one would be a
 * layer of authority the design never granted.
 */
export const CLAUDE_RENDER_LAYERS = Object.freeze([
  "PROJECT_INSTRUCTIONS_CANONICAL",
  "TASK_CONTEXT",
  "SKILLS_ADVISORY",
] as const);
export type ClaudeRenderLayer = (typeof CLAUDE_RENDER_LAYERS)[number];

/**
 * Mirrors the bounds @moe/skills already enforces on a snapshot. They are
 * re-checked here because the snapshot crosses a package boundary as data: an
 * unbounded one would be concatenated into advisory bytes BEFORE the context
 * limit could reject it, so the limit alone is not a memory bound.
 */
export const MAX_MIRRORED_SKILLS = 16;
export const MAX_MIRRORED_SKILL_FILES = 64;

export const CLAUDE_RENDER_ERROR_CODES = Object.freeze([
  "CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN",
  "CLAUDE_RENDER_CONTEXT_TOO_LARGE",
  "CLAUDE_RENDER_SKILL_SNAPSHOT_INVALID",
  "CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT",
  "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
  "CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
  "CLAUDE_RENDER_TASK_CONTEXT_INVALID",
] as const);
export type ClaudeRenderErrorCode = (typeof CLAUDE_RENDER_ERROR_CODES)[number];

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

export interface ClaudeTokenizerPort {
  readonly countTokens: (bytes: Uint8Array) => number;
}

export interface ClaudeRenderLayerEntry {
  readonly layer: ClaudeRenderLayer;
  readonly authority: "NONE";
  readonly mandatory: boolean;
  readonly included: boolean;
  readonly byteLength: number;
  readonly sha256: string;
  readonly exclusionReason: string | null;
}

export interface ClaudeRenderedContext {
  readonly rendererEnvelopeVersion: typeof CLAUDE_RENDERER_ENVELOPE_VERSION;
  readonly authority: "NONE";
  readonly advisoryOnly: true;
  readonly layerManifest: readonly ClaudeRenderLayerEntry[];
  /** Base64, never a typed array: `Object.freeze` throws on a non-empty one. */
  readonly renderedBase64: string;
  readonly renderedByteLength: number;
  readonly providerInputDigest: string;
  readonly tokenCount: number | "UNKNOWN";
  readonly enforcedBound: ClaudeContextLimit;
}

export interface RenderClaudeContextInput {
  readonly agentsContractBytes: Uint8Array;
  readonly taskContext: { readonly taskRef: string; readonly bodyBytes: Uint8Array };
  readonly skillSnapshot: MirroredSkillRendererInput;
  readonly contextLimit: ClaudeContextLimit;
  readonly tokenizer: ClaudeTokenizerPort | null;
}

export interface RenderClaudeContextOk {
  readonly ok: true;
  readonly rendered: ClaudeRenderedContext;
}

export type RenderClaudeContextResult =
  | RenderClaudeContextOk
  | ClaudeFailure<ClaudeRenderErrorCode>;

const encoder = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function header(layer: ClaudeRenderLayer, byteLength: number): Uint8Array {
  return encoder.encode(
    `--- ${CLAUDE_RENDERER_ENVELOPE_VERSION} layer=${layer} authority=NONE bytes=${byteLength} ---\n`,
  );
}

/**
 * Skills and their files are ordered by identity, not by however the caller
 * happened to build the snapshot. Two snapshots holding the same advisory
 * material must render to the same bytes, or the provider input digest would
 * record a difference that does not exist.
 */
function advisoryBytes(snapshot: MirroredSkillRendererInput): Uint8Array | ClaudeFailure<ClaudeRenderErrorCode> {
  const parts: Uint8Array[] = [];
  if (!Array.isArray(snapshot.skills) || snapshot.skills.length > MAX_MIRRORED_SKILLS) {
    return claudeFailure(
      "CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT",
      `a snapshot may carry at most ${MAX_MIRRORED_SKILLS} skills`,
    );
  }
  const skills = [...snapshot.skills].sort((left, right) =>
    left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0,
  );
  for (const skill of skills) {
    if (!Array.isArray(skill.files) || skill.files.length > MAX_MIRRORED_SKILL_FILES) {
      return claudeFailure(
        "CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT",
        `skill ${JSON.stringify(skill.skillId)} may carry at most ${MAX_MIRRORED_SKILL_FILES} files`,
      );
    }
    if (!isHex64(skill.bundleDigest)) {
      return claudeFailure(
        "CLAUDE_RENDER_SKILL_SNAPSHOT_INVALID",
        `skill ${JSON.stringify(skill.skillId)} has no bundle digest`,
      );
    }
    parts.push(encoder.encode(`# skill ${skill.skillId}@${skill.version} authority=NONE\n`));
    const files = [...skill.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    for (const file of files) {
      const bytes = new Uint8Array(Buffer.from(file.contentBase64, "base64"));
      if (!isSafeByteCount(file.byteLength) || bytes.byteLength !== file.byteLength) {
        return claudeFailure(
          "CLAUDE_RENDER_SKILL_SNAPSHOT_INVALID",
          `skill file ${JSON.stringify(file.path)} declares a byte length it does not have`,
        );
      }
      if (!isHex64(file.sha256) || sha256Hex(bytes) !== file.sha256) {
        return claudeFailure(
          "CLAUDE_RENDER_SKILL_SNAPSHOT_INVALID",
          `skill file ${JSON.stringify(file.path)} does not match its declared digest`,
        );
      }
      parts.push(encoder.encode(`## ${file.path}\n`), bytes, encoder.encode("\n"));
    }
  }
  return concat(parts);
}

function isFailure(value: unknown): value is ClaudeFailure<ClaudeRenderErrorCode> {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function layerEntry(
  layer: ClaudeRenderLayer,
  bytes: Uint8Array,
  mandatory: boolean,
  included: boolean,
  exclusionReason: string | null,
): ClaudeRenderLayerEntry {
  return {
    layer,
    authority: "NONE",
    mandatory,
    included,
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    exclusionReason,
  };
}

function framed(layer: ClaudeRenderLayer, bytes: Uint8Array): Uint8Array {
  return concat([header(layer, bytes.byteLength), bytes, encoder.encode("\n")]);
}

/** Byte budget, or null when no trustworthy bound exists (design 14.2). */
function byteBudget(limit: ClaudeContextLimit, tokenizer: ClaudeTokenizerPort | null): number | null {
  if (limit.kind === "CONSERVATIVE_INPUT_BYTES") {
    return limit.bytes;
  }
  if (limit.kind === "EXACT_TOKENS" && tokenizer !== null) {
    return Number.MAX_SAFE_INTEGER;
  }
  return null;
}

/**
 * A tokenizer that throws has not proven a count, so the bound it was supposed
 * to enforce is not trustworthy. Returning `null` routes that to
 * CONTEXT_LIMIT_UNKNOWN rather than letting a caller's exception escape a
 * function whose whole contract is typed refusal.
 */
function countTokens(tokenizer: ClaudeTokenizerPort, bytes: Uint8Array): number | null {
  try {
    const count = tokenizer.countTokens(bytes);
    return isSafeByteCount(count) ? count : null;
  } catch {
    return null;
  }
}

type BudgetVerdict = "WITHIN" | "EXCEEDED" | "UNTRUSTWORTHY";

function withinTokenBudget(
  limit: ClaudeContextLimit,
  tokenizer: ClaudeTokenizerPort | null,
  bytes: Uint8Array,
): BudgetVerdict {
  if (limit.kind !== "EXACT_TOKENS" || tokenizer === null) {
    return "WITHIN";
  }
  const count = countTokens(tokenizer, bytes);
  if (count === null) {
    return "UNTRUSTWORTHY";
  }
  return count <= limit.tokens ? "WITHIN" : "EXCEEDED";
}

export function renderClaudeContext(input: RenderClaudeContextInput): RenderClaudeContextResult {
  const snapshot = input.skillSnapshot;
  if (snapshot.rendererInputVersion !== MIRRORED_SKILL_RENDERER_INPUT_VERSION) {
    return claudeFailure(
      "CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
      `skill snapshot declares renderer input version ${JSON.stringify(snapshot.rendererInputVersion)}`,
    );
  }
  if (snapshot.authority !== "NONE" || snapshot.advisoryOnly !== true) {
    return claudeFailure(
      "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
      "a skill snapshot that claims authority is refused, never sanitised",
    );
  }
  if (input.taskContext.taskRef.length === 0) {
    return claudeFailure("CLAUDE_RENDER_TASK_CONTEXT_INVALID", "task context needs a task ref");
  }
  const advisory = advisoryBytes(snapshot);
  if (isFailure(advisory)) {
    return advisory;
  }
  const budget = byteBudget(input.contextLimit, input.tokenizer);
  if (budget === null) {
    return claudeFailure(
      "CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN",
      "neither an exact token limit with a tokenizer nor a conservative byte bound is available",
    );
  }
  // Checked before framing: framing only ever grows the payload, so an input
  // that already exceeds the budget cannot be rescued by copying it first.
  if (input.agentsContractBytes.byteLength + input.taskContext.bodyBytes.byteLength > budget) {
    return claudeFailure(
      "CLAUDE_RENDER_CONTEXT_TOO_LARGE",
      "mandatory context exceeds the declared bound before any envelope is added",
    );
  }
  const instructions = framed("PROJECT_INSTRUCTIONS_CANONICAL", input.agentsContractBytes);
  const taskBody = concat([
    encoder.encode(`task=${input.taskContext.taskRef}\n`),
    input.taskContext.bodyBytes,
  ]);
  const task = framed("TASK_CONTEXT", taskBody);
  const advisoryFramed = framed("SKILLS_ADVISORY", advisory);
  const mandatoryBytes = concat([instructions, task]);
  const mandatoryVerdict = withinTokenBudget(input.contextLimit, input.tokenizer, mandatoryBytes);
  if (mandatoryVerdict === "UNTRUSTWORTHY") {
    return claudeFailure(
      "CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN",
      "the tokenizer did not return a usable count, so the declared token bound cannot be enforced",
    );
  }
  if (mandatoryBytes.byteLength > budget || mandatoryVerdict === "EXCEEDED") {
    return claudeFailure(
      "CLAUDE_RENDER_CONTEXT_TOO_LARGE",
      `mandatory context is ${mandatoryBytes.byteLength} bytes and does not fit the declared bound`,
    );
  }
  const full = concat([mandatoryBytes, advisoryFramed]);
  const advisoryFits =
    full.byteLength <= budget &&
    withinTokenBudget(input.contextLimit, input.tokenizer, full) === "WITHIN";
  const renderedBytes = advisoryFits ? full : mandatoryBytes;
  const rendered = deepFreeze({
    rendererEnvelopeVersion: CLAUDE_RENDERER_ENVELOPE_VERSION,
    authority: "NONE",
    advisoryOnly: true,
    layerManifest: [
      layerEntry("PROJECT_INSTRUCTIONS_CANONICAL", instructions, true, true, null),
      layerEntry("TASK_CONTEXT", task, true, true, null),
      layerEntry(
        "SKILLS_ADVISORY",
        advisoryFramed,
        false,
        advisoryFits,
        advisoryFits ? null : "ADVISORY_LAYER_EXCEEDS_CONTEXT_BOUND",
      ),
    ],
    renderedBase64: Buffer.from(renderedBytes).toString("base64"),
    renderedByteLength: renderedBytes.byteLength,
    providerInputDigest: sha256Hex(renderedBytes),
    tokenCount:
      input.tokenizer === null ? "UNKNOWN" : (countTokens(input.tokenizer, renderedBytes) ?? "UNKNOWN"),
    enforcedBound: { ...input.contextLimit },
  } satisfies ClaudeRenderedContext);
  return Object.freeze({ ok: true as const, rendered });
}

/**
 * The renderer-envelope tuple design 6.4 binds alongside the digest. Exported so
 * a caller can record what produced the bytes without re-deriving it.
 */
export function rendererEnvelopeIdentity(rendered: ClaudeRenderedContext): string {
  return canonicalDigest({
    rendererEnvelopeVersion: rendered.rendererEnvelopeVersion,
    providerInputDigest: rendered.providerInputDigest,
    layerManifest: rendered.layerManifest.map((entry) => ({
      layer: entry.layer,
      included: entry.included,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    })),
  });
}
