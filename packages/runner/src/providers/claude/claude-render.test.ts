import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../canonical.js";
import {
  CLAUDE_RENDERER_ENVELOPE_VERSION,
  CLAUDE_RENDER_LAYERS,
  MIRRORED_SKILL_RENDERER_INPUT_VERSION,
  renderClaudeContext,
  type MirroredSkillRendererInput,
  type RenderClaudeContextInput,
} from "./claude-render.js";

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function skillFile(path: string, body: string) {
  return {
    path,
    sha256: sha256Hex(utf8(body)),
    byteLength: utf8(body).byteLength,
    contentBase64: base64(body),
  };
}

function snapshot(): MirroredSkillRendererInput {
  return {
    rendererInputVersion: MIRRORED_SKILL_RENDERER_INPUT_VERSION,
    authority: "NONE",
    advisoryOnly: true,
    skills: [
      {
        skillId: "tdd",
        version: "1.0.0",
        origin: "authored",
        bundleDigest: "c".repeat(64),
        files: [skillFile("SKILL.md", "write the test first"), skillFile("a.md", "alpha")],
      },
      {
        skillId: "review",
        version: "2.0.0",
        origin: "authored",
        bundleDigest: "d".repeat(64),
        files: [skillFile("SKILL.md", "read your own diff")],
      },
    ],
  };
}

function renderInput(
  overrides: Partial<RenderClaudeContextInput> = {},
): RenderClaudeContextInput {
  return {
    agentsContractBytes: utf8("# AGENTS.md\ncanonical project instructions"),
    taskContext: { taskRef: "task-render", bodyBytes: utf8("objective: land the adapter") },
    skillSnapshot: snapshot(),
    contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 1_048_576 },
    tokenizer: null,
    ...overrides,
  };
}

function renderOrThrow(input: RenderClaudeContextInput = renderInput()) {
  const result = renderClaudeContext(input);
  if (!result.ok) {
    throw new Error(`render failed: ${result.code} ${result.message}`);
  }
  return result.rendered;
}

describe("deterministic context render", () => {
  it("renders the closed layer order and binds an adapter-observed digest", () => {
    const rendered = renderOrThrow();
    expect(rendered.rendererEnvelopeVersion).toBe(CLAUDE_RENDERER_ENVELOPE_VERSION);
    expect(rendered.layerManifest.map((entry) => entry.layer)).toEqual([...CLAUDE_RENDER_LAYERS]);
    for (const entry of rendered.layerManifest) {
      expect(entry.authority).toBe("NONE");
    }
    expect(rendered.providerInputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(rendered.advisoryOnly).toBe(true);
    expect(rendered.authority).toBe("NONE");
    expect(Object.isFrozen(rendered)).toBe(true);
  });

  it("is byte identical across runs and independent of input ordering", () => {
    const first = renderOrThrow();
    const second = renderOrThrow();
    expect(second.renderedBase64).toBe(first.renderedBase64);
    expect(second.providerInputDigest).toBe(first.providerInputDigest);

    const shuffled = snapshot();
    const reordered: MirroredSkillRendererInput = {
      advisoryOnly: true,
      authority: "NONE",
      rendererInputVersion: MIRRORED_SKILL_RENDERER_INPUT_VERSION,
      skills: [...shuffled.skills].reverse().map((skill) => ({
        ...skill,
        files: [...skill.files].reverse(),
      })),
    };
    const same = renderOrThrow(renderInput({ skillSnapshot: reordered }));
    expect(same.renderedBase64).toBe(first.renderedBase64);
    expect(same.providerInputDigest).toBe(first.providerInputDigest);
  });

  it("changes the digest when the renderer envelope input changes", () => {
    const base = renderOrThrow();
    const other = renderOrThrow(
      renderInput({
        taskContext: { taskRef: "task-render", bodyBytes: utf8("objective: something else") },
      }),
    );
    expect(other.providerInputDigest).not.toBe(base.providerInputDigest);
    expect(
      sha256Hex(new Uint8Array(Buffer.from(base.renderedBase64, "base64"))),
    ).not.toBe(sha256Hex(new Uint8Array(Buffer.from(other.renderedBase64, "base64"))));
  });

  it("cannot express command, effect, or lease authority", () => {
    const rendered = renderOrThrow();
    const serialized = JSON.stringify(rendered);
    for (const forbidden of [
      "commandKind",
      "leaseAuthority",
      "effectIntent",
      "approval",
      "capabilityGrant",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(rendered).sort()).toEqual([
      "advisoryOnly",
      "authority",
      "enforcedBound",
      "layerManifest",
      "providerInputDigest",
      "renderedBase64",
      "renderedByteLength",
      "rendererEnvelopeVersion",
      "tokenCount",
    ]);
  });
});

describe("context limit behaviour", () => {
  it("refuses to render when mandatory bytes exceed the declared bound", () => {
    const result = renderClaudeContext(
      renderInput({ contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 32 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_RENDER_CONTEXT_TOO_LARGE");
  });

  it("excludes the advisory layer with a recorded reason rather than truncating it", () => {
    const rendered = renderOrThrow(
      renderInput({ contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 300 } }),
    );
    const advisory = rendered.layerManifest.find((entry) => entry.layer === "SKILLS_ADVISORY");
    expect(advisory?.included).toBe(false);
    expect(advisory?.exclusionReason).toBe("ADVISORY_LAYER_EXCEEDS_CONTEXT_BOUND");
    expect(rendered.renderedByteLength).toBeLessThanOrEqual(300);
    expect(Buffer.from(rendered.renderedBase64, "base64").toString("utf8")).not.toContain(
      "write the test first",
    );
  });

  it("holds unknown when no trustworthy bound exists", () => {
    const unknown = renderClaudeContext(renderInput({ contextLimit: { kind: "UNKNOWN" } }));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe("CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN");

    const tokensWithoutTokenizer = renderClaudeContext(
      renderInput({ contextLimit: { kind: "EXACT_TOKENS", tokens: 200_000 }, tokenizer: null }),
    );
    expect(tokensWithoutTokenizer.ok).toBe(false);
    if (tokensWithoutTokenizer.ok) return;
    expect(tokensWithoutTokenizer.code).toBe("CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN");
  });

  it("labels the token count UNKNOWN when no tokenizer is proven, and counts when one is", () => {
    expect(renderOrThrow().tokenCount).toBe("UNKNOWN");
    const counted = renderOrThrow(
      renderInput({
        contextLimit: { kind: "EXACT_TOKENS", tokens: 200_000 },
        tokenizer: { countTokens: (bytes) => bytes.byteLength },
      }),
    );
    expect(counted.tokenCount).toBe(counted.renderedByteLength);
  });

  it("refuses a token budget the tokenizer says is exceeded", () => {
    const result = renderClaudeContext(
      renderInput({
        contextLimit: { kind: "EXACT_TOKENS", tokens: 4 },
        tokenizer: { countTokens: (bytes) => bytes.byteLength },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_RENDER_CONTEXT_TOO_LARGE");
  });
});

describe("hostile skill snapshots", () => {
  it("refuses anything that is not the pinned advisory renderer input", () => {
    const cases: ReadonlyArray<readonly [MirroredSkillRendererInput, string]> = [
      [
        { ...snapshot(), rendererInputVersion: "moe-skill-renderer-input/2" },
        "CLAUDE_RENDER_SKILL_SNAPSHOT_VERSION_UNSUPPORTED",
      ],
      [
        { ...snapshot(), authority: "GRANTED" as unknown as "NONE" },
        "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
      ],
      [
        { ...snapshot(), advisoryOnly: false as unknown as true },
        "CLAUDE_RENDER_SKILL_SNAPSHOT_NOT_ADVISORY",
      ],
    ];
    for (const [skillSnapshot, code] of cases) {
      const result = renderClaudeContext(renderInput({ skillSnapshot }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(code);
    }
  });

  it("bounds the snapshot so it cannot be concatenated before the limit rejects it", () => {
    const one = snapshot().skills[0]!;
    const many = renderClaudeContext(
      renderInput({
        skillSnapshot: {
          ...snapshot(),
          skills: Array.from({ length: 17 }, (_, index) => ({ ...one, skillId: `s${index}` })),
        },
      }),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.code).toBe("CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT");

    const files = renderClaudeContext(
      renderInput({
        skillSnapshot: {
          ...snapshot(),
          skills: [{ ...one, files: Array.from({ length: 65 }, () => one.files[0]!) }],
        },
      }),
    );
    expect(files.ok).toBe(false);
    if (!files.ok) expect(files.code).toBe("CLAUDE_RENDER_SKILL_SNAPSHOT_LIMIT");
  });

  it("treats a tokenizer that throws as an unenforceable bound, not an exception", () => {
    const result = renderClaudeContext(
      renderInput({
        contextLimit: { kind: "EXACT_TOKENS", tokens: 200_000 },
        tokenizer: {
          countTokens: () => {
            throw new Error("tokenizer unavailable");
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_RENDER_CONTEXT_LIMIT_UNKNOWN");
  });

  it("refuses a skill file whose bytes do not match its declared digest", () => {
    const tampered = snapshot();
    const result = renderClaudeContext(
      renderInput({
        skillSnapshot: {
          ...tampered,
          skills: [
            {
              ...tampered.skills[0]!,
              files: [{ ...tampered.skills[0]!.files[0]!, contentBase64: base64("swapped body") }],
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLAUDE_RENDER_SKILL_SNAPSHOT_INVALID");
  });
});
