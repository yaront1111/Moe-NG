import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { MAX_JSON_BODY_BYTES, decodeBoundedJsonBytes } from "@moe/contracts";
import { previewGraphSnapshot } from "@moe/scheduler";
import type { JsonObject } from "@moe/contracts";
import type { GraphPreviewOptions } from "@moe/scheduler";
import { describe, expect, it } from "vitest";

import * as daemon from "./index.js";

const SCHEMA_VERSION = "moe-graph-preview-request/1";
const REQUEST_ERROR = Object.freeze({
  code: "GRAPH_PREVIEW_REQUEST_INVALID",
  message: "Graph preview request must match moe-graph-preview-request/1 exactly.",
});
const encoder = new TextEncoder();

type RuntimeEvaluate = (input: unknown) => unknown;

function evaluate(input: unknown): unknown {
  const candidate: unknown = (daemon as Readonly<Record<string, unknown>>)[
    "evaluateGraphPreviewRequestBytes"
  ];
  if (typeof candidate !== "function") return undefined;
  return (candidate as RuntimeEvaluate)(input);
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function validSnapshot(): JsonObject {
  return {
    completionNodeKey: "dev-done",
    edges: [],
    nodes: [{ executionBearing: true, nodeKey: "dev-done" }],
  };
}

function validRequest(
  snapshot: unknown = validSnapshot(),
  options?: unknown,
): Record<string, unknown> {
  return options === undefined
    ? { schemaVersion: SCHEMA_VERSION, snapshot }
    : { options, schemaVersion: SCHEMA_VERSION, snapshot };
}

function expectedPreview(input: Uint8Array) {
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || decoded.value === null || Array.isArray(decoded.value)) {
    throw new Error("test request must decode to an object");
  }
  if (typeof decoded.value !== "object") {
    throw new Error("test request must decode to an object");
  }
  const request = decoded.value as JsonObject;
  const options = Object.hasOwn(request, "options")
    ? (request.options as GraphPreviewOptions)
    : undefined;
  return previewGraphSnapshot(request.snapshot, options);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function collectKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (value === null || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("evaluateGraphPreviewRequestBytes", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["boolean", true],
    ["number", 1],
    ["string", "request"],
    ["empty object", {}],
    ["missing snapshot", { schemaVersion: SCHEMA_VERSION }],
    ["missing schema version", { snapshot: validSnapshot() }],
    [
      "wrong schema version",
      { schemaVersion: "moe-graph-preview-request/2", snapshot: validSnapshot() },
    ],
    ["extra key", { ...validRequest(), execute: true }],
  ])("rejects a decoded %s envelope", (_label, request) => {
    expect(evaluate(bytes(request))).toEqual({
      advisoryOnly: true,
      authority: "NONE",
      error: REQUEST_ERROR,
      ok: false,
      outcome: "REQUEST_INVALID",
    });
  });

  it.each([
    [
      "non-byte input",
      "{}",
      "JSON_INPUT_TYPE_INVALID",
      "JSON input must be a supported fixed byte array.",
    ],
    [
      "malformed UTF-8",
      new Uint8Array([0xc3, 0x28]),
      "JSON_UTF8_INVALID",
      "JSON input is not valid UTF-8.",
    ],
    [
      "malformed JSON",
      encoder.encode("{"),
      "JSON_SYNTAX_INVALID",
      "JSON text is not syntactically valid.",
    ],
    [
      "empty body",
      new Uint8Array(),
      "JSON_SYNTAX_INVALID",
      "JSON text is not syntactically valid.",
    ],
    [
      "duplicate keys",
      encoder.encode(
        `{"schemaVersion":"${SCHEMA_VERSION}","snapshot":{},"snapshot":{}}`,
      ),
      "JSON_DUPLICATE_KEY",
      "JSON object contains a duplicate decoded key.",
    ],
    [
      "oversized body",
      new Uint8Array(MAX_JSON_BODY_BYTES + 1),
      "JSON_BODY_LIMIT_EXCEEDED",
      `JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes.`,
    ],
  ])("preserves the bounded decoder failure for %s", (_label, input, code, message) => {
    expect(evaluate(input)).toEqual({
      advisoryOnly: true,
      authority: "NONE",
      error: { code, message, ok: false },
      ok: false,
      outcome: "INPUT_REJECTED",
    });
  });

  it.each([
    ["valid graph", validRequest(), "ANALYZED"],
    ["null graph", validRequest(null), "GRAPH_INVALID"],
    ["malformed graph", validRequest({}), "GRAPH_INVALID"],
    ["malformed options", validRequest(validSnapshot(), null), "OPTIONS_INVALID"],
    [
      "malformed policy",
      validRequest(validSnapshot(), { policyOverride: { maxNodes: -1 } }),
      "POLICY_INVALID",
    ],
    [
      "malformed frontier",
      validRequest(validSnapshot(), { frontierCursor: {} }),
      "FRONTIER_INVALID",
    ],
  ])("carries the unchanged scheduler result for %s", (_label, request, outcome) => {
    const input = bytes(request);
    const preview = expectedPreview(input);

    expect(preview.outcome).toBe(outcome);
    expect(evaluate(input)).toEqual({
      advisoryOnly: true,
      authority: "NONE",
      ok: true,
      outcome: "REQUEST_EVALUATED",
      preview,
    });
  });

  it("returns exact deeply frozen outer envelopes", () => {
    const rejected = evaluate(encoder.encode("{"));
    const invalid = evaluate(bytes(null));
    const evaluated = evaluate(bytes(validRequest()));

    expect(rejected).toEqual(expect.any(Object));
    expect(invalid).toEqual(expect.any(Object));
    expect(evaluated).toEqual(expect.any(Object));
    expect(Object.keys(rejected as object).sort()).toEqual([
      "advisoryOnly", "authority", "error", "ok", "outcome",
    ]);
    expect(Object.keys(invalid as object).sort()).toEqual([
      "advisoryOnly", "authority", "error", "ok", "outcome",
    ]);
    expect(Object.keys(evaluated as object).sort()).toEqual([
      "advisoryOnly", "authority", "ok", "outcome", "preview",
    ]);
    expectDeepFrozen(rejected);
    expectDeepFrozen(invalid);
    expectDeepFrozen(evaluated);
    for (const request of [
      validRequest(null),
      validRequest(validSnapshot(), null),
      validRequest(validSnapshot(), { policyOverride: { maxNodes: -1 } }),
      validRequest(validSnapshot(), { frontierCursor: {} }),
    ]) expectDeepFrozen(evaluate(bytes(request)));
  });

  it("is deterministic for equivalent request bytes", () => {
    const first = bytes(validRequest());
    const reordered = bytes({
      snapshot: validSnapshot(),
      schemaVersion: SCHEMA_VERSION,
    });
    const firstResult = evaluate(first);
    const reorderedResult = evaluate(reordered);

    expect(firstResult).toEqual(expect.any(Object));
    expect(JSON.stringify(firstResult)).toBe(JSON.stringify(reorderedResult));
  });

  it("exposes no mutation or execution affordance", () => {
    const keys = collectKeys(evaluate(bytes(validRequest())));

    expect(keys.has("authority")).toBe(true);
    for (const forbidden of [
      "nextAllowedCommands",
      "mutation",
      "approval",
      "activation",
      "provider",
      "execution",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("exports only the byte evaluator from the package root", () => {
    expect(Object.keys(daemon)).toEqual(["evaluateGraphPreviewRequestBytes"]);
  });

  it("loads and evaluates through the real package-root specifier", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const script = [
      'import { evaluateGraphPreviewRequestBytes as evaluate } from "@moe/daemon";',
      "const request = {",
      `schemaVersion: "${SCHEMA_VERSION}",`,
      "snapshot: { completionNodeKey: 'dev-done', edges: [],",
      "nodes: [{ executionBearing: true, nodeKey: 'dev-done' }] },",
      "};",
      "const input = new TextEncoder().encode(JSON.stringify(request));",
      "process.stdout.write(JSON.stringify(evaluate(input)));",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      advisoryOnly: true,
      authority: "NONE",
      ok: true,
      outcome: "REQUEST_EVALUATED",
      preview: { outcome: "ANALYZED" },
    });
  });

  it("keeps internal source subpaths sealed", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const script = [
      'try { await import("@moe/daemon/src/index.ts"); process.exitCode = 2; }',
      "catch (error) { process.stdout.write(error?.code ?? ''); }",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});
