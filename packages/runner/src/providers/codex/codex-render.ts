import { canonicalDigest, deepFreeze, isSafeByteCount, sha256Hex } from "../../canonical.js";
import type { CodexContextLimit } from "./codex-capabilities.js";
import { codexFailure, type CodexFailure } from "./codex-observation.js";
import {
  MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  renderAdvisorySkills,
  type CodexRenderErrorCode,
  type MirroredSkillRendererInput,
} from "./codex-render-skills.js";

export const CODEX_RENDERER_ENVELOPE_VERSION = "moe-codex-renderer-envelope/1" as const;
export const CODEX_RENDER_LAYERS = Object.freeze([
  "PROJECT_INSTRUCTIONS_CANONICAL", "TASK_CONTEXT", "SKILLS_ADVISORY",
] as const);
export type CodexRenderLayer = (typeof CODEX_RENDER_LAYERS)[number];

export interface CodexTokenizerPort {
  readonly countTokens: (bytes: Uint8Array) => number;
}

export interface CodexRenderLayerEntry {
  readonly layer: CodexRenderLayer;
  readonly authority: "NONE";
  readonly mandatory: boolean;
  readonly included: boolean;
  readonly byteLength: number;
  readonly sha256: string;
  readonly exclusionReason: string | null;
}

export interface CodexRenderedContext {
  readonly rendererEnvelopeVersion: typeof CODEX_RENDERER_ENVELOPE_VERSION;
  readonly authority: "NONE";
  readonly advisoryOnly: true;
  readonly layerManifest: readonly CodexRenderLayerEntry[];
  readonly renderedBase64: string;
  readonly renderedByteLength: number;
  readonly providerInputDigest: string;
  readonly tokenCount: number | "UNKNOWN";
  readonly enforcedBound: CodexContextLimit;
}

export interface RenderCodexContextInput {
  readonly agentsContractBytes: Uint8Array;
  readonly taskContext: { readonly taskRef: string; readonly bodyBytes: Uint8Array };
  readonly skillSnapshot: MirroredSkillRendererInput;
  readonly contextLimit: CodexContextLimit;
  readonly tokenizer: CodexTokenizerPort | null;
}

export type RenderCodexContextResult =
  | { readonly ok: true; readonly rendered: CodexRenderedContext }
  | CodexFailure<CodexRenderErrorCode>;

export {
  CODEX_RENDER_ERROR_CODES,
  MAX_MIRRORED_SKILLS,
  MAX_MIRRORED_SKILL_FILES,
  MIRRORED_SKILL_RENDERER_INPUT_VERSION,
} from "./codex-render-skills.js";
export type {
  CodexRenderErrorCode,
  MirroredSkillEntry,
  MirroredSkillFile,
  MirroredSkillRendererInput,
} from "./codex-render-skills.js";

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

function framed(layer: CodexRenderLayer, bytes: Uint8Array): Uint8Array {
  const header = encoder.encode(
    `--- ${CODEX_RENDERER_ENVELOPE_VERSION} layer=${layer} authority=NONE bytes=${bytes.byteLength} ---\n`,
  );
  return concat([header, bytes, encoder.encode("\n")]);
}

function layerEntry(
  layer: CodexRenderLayer,
  bytes: Uint8Array,
  mandatory: boolean,
  included: boolean,
): CodexRenderLayerEntry {
  return {
    layer, authority: "NONE", mandatory, included, byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes),
    exclusionReason: included ? null : "ADVISORY_LAYER_EXCEEDS_CONTEXT_BOUND",
  };
}

function countTokens(port: CodexTokenizerPort, bytes: Uint8Array): number | null {
  try {
    const count = port.countTokens(bytes);
    return isSafeByteCount(count) ? count : null;
  } catch { return null; }
}

type BudgetVerdict = "WITHIN" | "EXCEEDED" | "UNTRUSTWORTHY";

function tokenVerdict(
  limit: CodexContextLimit,
  port: CodexTokenizerPort | null,
  bytes: Uint8Array,
): BudgetVerdict {
  if (limit.kind !== "EXACT_TOKENS" || port === null) return "WITHIN";
  const count = countTokens(port, bytes);
  if (count === null) return "UNTRUSTWORTHY";
  return count <= limit.tokens ? "WITHIN" : "EXCEEDED";
}

function byteBudget(limit: CodexContextLimit, port: CodexTokenizerPort | null): number | null {
  if (limit.kind === "CONSERVATIVE_INPUT_BYTES") return limit.bytes;
  if (limit.kind === "EXACT_TOKENS" && port !== null) return Number.MAX_SAFE_INTEGER;
  return null;
}

function isFailure(value: unknown): value is CodexFailure<CodexRenderErrorCode> {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

interface PreparedLayers {
  readonly instructions: Uint8Array;
  readonly task: Uint8Array;
  readonly advisory: Uint8Array;
}

function prepareLayers(input: RenderCodexContextInput): PreparedLayers | CodexFailure<CodexRenderErrorCode> {
  if (!(input.agentsContractBytes instanceof Uint8Array) ||
      !(input.taskContext.bodyBytes instanceof Uint8Array) || input.taskContext.taskRef.length === 0) {
    return codexFailure("CODEX_RENDER_TASK_CONTEXT_INVALID", "canonical instructions and task context are required");
  }
  const advisory = renderAdvisorySkills(input.skillSnapshot);
  if (isFailure(advisory)) return advisory;
  return {
    instructions: framed("PROJECT_INSTRUCTIONS_CANONICAL", input.agentsContractBytes),
    task: framed("TASK_CONTEXT", concat([
      encoder.encode(`task=${input.taskContext.taskRef}\n`), input.taskContext.bodyBytes,
    ])),
    advisory: framed("SKILLS_ADVISORY", advisory),
  };
}

function validateSnapshot(snapshot: MirroredSkillRendererInput): CodexFailure<CodexRenderErrorCode> | null {
  if (snapshot.rendererInputVersion !== MIRRORED_SKILL_RENDERER_INPUT_VERSION) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED", "skill snapshot version is unsupported");
  }
  if (snapshot.authority !== "NONE" || snapshot.advisoryOnly !== true) {
    return codexFailure("CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY", "authority-bearing skill snapshot is refused");
  }
  return null;
}

export function renderCodexContext(input: RenderCodexContextInput): RenderCodexContextResult {
  const invalidSnapshot = validateSnapshot(input.skillSnapshot);
  if (invalidSnapshot !== null) return invalidSnapshot;
  const budget = byteBudget(input.contextLimit, input.tokenizer);
  if (budget === null) {
    return codexFailure("CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN", "no enforceable context bound is available");
  }
  if (input.agentsContractBytes.byteLength + input.taskContext.bodyBytes.byteLength > budget) {
    return codexFailure("CODEX_RENDER_CONTEXT_TOO_LARGE", "mandatory context exceeds the pre-frame bound");
  }
  const layers = prepareLayers(input);
  if (isFailure(layers)) return layers;
  const mandatory = concat([layers.instructions, layers.task]);
  const mandatoryVerdict = tokenVerdict(input.contextLimit, input.tokenizer, mandatory);
  if (mandatory.byteLength > budget || mandatoryVerdict === "EXCEEDED") {
    return codexFailure("CODEX_RENDER_CONTEXT_TOO_LARGE", "mandatory context exceeds its bound");
  }
  if (mandatoryVerdict === "UNTRUSTWORTHY") {
    return codexFailure("CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN", "tokenizer returned no trustworthy count");
  }
  const full = concat([mandatory, layers.advisory]);
  const advisoryFits = full.byteLength <= budget &&
    tokenVerdict(input.contextLimit, input.tokenizer, full) === "WITHIN";
  const renderedBytes = advisoryFits ? full : mandatory;
  const rendered = deepFreeze({
    rendererEnvelopeVersion: CODEX_RENDERER_ENVELOPE_VERSION,
    authority: "NONE",
    advisoryOnly: true,
    layerManifest: [
      layerEntry("PROJECT_INSTRUCTIONS_CANONICAL", layers.instructions, true, true),
      layerEntry("TASK_CONTEXT", layers.task, true, true),
      layerEntry("SKILLS_ADVISORY", layers.advisory, false, advisoryFits),
    ],
    renderedBase64: Buffer.from(renderedBytes).toString("base64"),
    renderedByteLength: renderedBytes.byteLength,
    providerInputDigest: sha256Hex(renderedBytes),
    tokenCount: input.tokenizer === null ? "UNKNOWN" :
      (countTokens(input.tokenizer, renderedBytes) ?? "UNKNOWN"),
    enforcedBound: { ...input.contextLimit },
  } satisfies CodexRenderedContext);
  return Object.freeze({ ok: true as const, rendered });
}

export function rendererEnvelopeIdentity(rendered: CodexRenderedContext): string {
  return canonicalDigest({
    rendererEnvelopeVersion: rendered.rendererEnvelopeVersion,
    providerInputDigest: rendered.providerInputDigest,
    layerManifest: rendered.layerManifest.map((entry) => ({
      layer: entry.layer, included: entry.included,
      byteLength: entry.byteLength, sha256: entry.sha256,
    })),
  });
}
