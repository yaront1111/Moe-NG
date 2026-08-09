import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../canonical.js";
import {
  MAX_MIRRORED_SKILL_FILES,
  MAX_MIRRORED_SKILLS,
  MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  renderCodexContext,
  rendererEnvelopeIdentity,
  type MirroredSkillEntry,
  type MirroredSkillFile,
  type MirroredSkillRendererInput,
  type RenderCodexContextInput,
} from "./codex-render.js";

const encoder = new TextEncoder();
const digest = (text: string) => sha256Hex(encoder.encode(text));

const file = (path: string, content: string): MirroredSkillFile => ({
  path,
  sha256: digest(content),
  byteLength: encoder.encode(content).byteLength,
  contentBase64: Buffer.from(content).toString("base64"),
});

const skill = (
  skillId: string,
  files: readonly MirroredSkillFile[] = [file("SKILL.md", `content:${skillId}`)],
): MirroredSkillEntry => ({
  skillId,
  version: "1",
  origin: "repo",
  bundleDigest: "a".repeat(64),
  files,
});

const snapshot = (skills: readonly MirroredSkillEntry[] = [skill("alpha")]): MirroredSkillRendererInput => ({
  rendererInputVersion: MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  authority: "NONE",
  advisoryOnly: true,
  skills,
});

const input = (overrides: Partial<RenderCodexContextInput> = {}): RenderCodexContextInput => ({
  agentsContractBytes: encoder.encode("canonical AGENTS.md"),
  taskContext: { taskRef: "task-1", bodyBytes: encoder.encode("task context") },
  skillSnapshot: snapshot(),
  contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 64 * 1024 },
  tokenizer: null,
  ...overrides,
});

describe("Codex deterministic provider input", () => {
  it("renders canonical instructions, task, and sorted advisory skills deterministically", () => {
    const first = renderCodexContext(input({
      skillSnapshot: snapshot([
        skill("zeta", [file("z.md", "z"), file("a.md", "a")]),
        skill("alpha"),
      ]),
    }));
    const second = renderCodexContext(input({
      skillSnapshot: snapshot([
        skill("alpha"),
        skill("zeta", [file("a.md", "a"), file("z.md", "z")]),
      ]),
    }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.rendered.providerInputDigest).toBe(second.rendered.providerInputDigest);
    expect(first.rendered.renderedBase64).toBe(second.rendered.renderedBase64);
    const text = Buffer.from(first.rendered.renderedBase64, "base64").toString("utf8");
    expect(text.indexOf("canonical AGENTS.md")).toBeLessThan(text.indexOf("task context"));
    expect(text.indexOf("# skill alpha@1")).toBeLessThan(text.indexOf("# skill zeta@1"));
    expect(text.indexOf("## a.md")).toBeLessThan(text.indexOf("## z.md"));
    expect(first.rendered.providerInputDigest).toBe(
      digest(Buffer.from(first.rendered.renderedBase64, "base64").toString("utf8")),
    );
  });

  it("returns only the exact non-authoritative frozen output shape", () => {
    const result = renderCodexContext(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.rendered).sort()).toEqual([
      "advisoryOnly", "authority", "enforcedBound", "layerManifest",
      "providerInputDigest", "renderedBase64", "renderedByteLength",
      "rendererEnvelopeVersion", "tokenCount",
    ]);
    expect(Object.keys(result.rendered.layerManifest[0] ?? {}).sort()).toEqual([
      "authority", "byteLength", "exclusionReason", "included", "layer",
      "mandatory", "sha256",
    ]);
    expect(result.rendered.authority).toBe("NONE");
    expect(result.rendered.advisoryOnly).toBe(true);
    expect(typeof result.rendered.renderedBase64).toBe("string");
    expect(Object.isFrozen(result.rendered)).toBe(true);
    expect(Object.isFrozen(result.rendered.layerManifest)).toBe(true);
    expect(rendererEnvelopeIdentity(result.rendered)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    [
      "version",
      { skillSnapshot: { ...snapshot(), rendererInputVersion: "future" } },
      "CODEX_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
    ],
    [
      "authority",
      { skillSnapshot: { ...snapshot(), authority: "GRANTED" } },
      "CODEX_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
    ],
    ["task", { taskContext: { taskRef: "", bodyBytes: encoder.encode("body") } }, "CODEX_RENDER_TASK_CONTEXT_INVALID"],
  ])("refuses invalid %s with its stable code", (_label, overrides, code) => {
    const result = renderCodexContext(input(overrides as Partial<RenderCodexContextInput>));
    expect(result).toMatchObject({ ok: false, code });
  });

  it("refuses a skill file whose declared digest differs from its bytes", () => {
    const bad = { ...file("SKILL.md", "content"), sha256: "b".repeat(64) };
    expect(renderCodexContext(input({ skillSnapshot: snapshot([skill("bad", [bad])]) }))).toMatchObject({
      ok: false,
      code: "CODEX_RENDER_SKILL_SNAPSHOT_INVALID",
    });
  });

  it("bounds both mirrored skill and aggregate file counts", () => {
    const tooManySkills = Array.from({ length: MAX_MIRRORED_SKILLS + 1 }, (_, index) => skill(`s-${index}`));
    const tooManyFiles = Array.from({ length: MAX_MIRRORED_SKILL_FILES + 1 }, (_, index) =>
      file(`${index}.md`, `${index}`));
    for (const skillSnapshot of [snapshot(tooManySkills), snapshot([skill("wide", tooManyFiles)])]) {
      expect(renderCodexContext(input({ skillSnapshot }))).toMatchObject({
        ok: false,
        code: "CODEX_RENDER_SKILL_SNAPSHOT_LIMIT",
      });
    }
  });

  it("checks mandatory bytes before framing and drops only an oversized advisory layer", () => {
    expect(renderCodexContext(input({
      contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 1 },
    }))).toMatchObject({ ok: false, code: "CODEX_RENDER_CONTEXT_TOO_LARGE" });

    const full = renderCodexContext(input());
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const mandatoryBytes = full.rendered.layerManifest.slice(0, 2)
      .reduce((sum, entry) => sum + entry.byteLength, 0);
    const bounded = renderCodexContext(input({
      contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: mandatoryBytes + 1 },
    }));
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.rendered.layerManifest[2]).toMatchObject({
      layer: "SKILLS_ADVISORY",
      included: false,
      authority: "NONE",
      exclusionReason: "ADVISORY_LAYER_EXCEEDS_CONTEXT_BOUND",
    });
  });

  it("maps an absent or throwing exact tokenizer to the stable unknown-limit refusal", () => {
    const exact = { kind: "EXACT_TOKENS" as const, tokens: 1000 };
    expect(renderCodexContext(input({ contextLimit: exact, tokenizer: null }))).toMatchObject({
      ok: false,
      code: "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN",
    });
    expect(renderCodexContext(input({
      contextLimit: exact,
      tokenizer: { countTokens: () => { throw new Error("offline"); } },
    }))).toMatchObject({ ok: false, code: "CODEX_RENDER_CONTEXT_LIMIT_UNKNOWN" });
  });
});
