/**
 * HOSTILE FIXTURES for the provider/launch group of the runtime-provider axis.
 *
 * NOT a `*.security.ts` file: the lane collects that suffix and a fixture module registering
 * as a suite with no cases would fail `passWithNoTests: false`.
 *
 * IT DECIDES NOTHING and it NEVER PRINTS PROVIDER OUTPUT. Every expected code and layer is
 * written at the case; the builders below only shape hostile bytes and inject the ports the
 * production surface already accepts.
 */

import { createHash } from "node:crypto";

import { expect } from "vitest";

import type { ProviderTelemetryLayer } from "../../packages/runner/src/providers/telemetry/provider-telemetry-contracts.js";
import type { Arm, Ledger } from "./runtime-provider-ledger.js";

/** A hostile capture the parser will refuse. Fields mirror `ClaudeStreamEvidence` exactly, so
 *  a case can flip ONE of them and leave the earlier gates satisfied. */
export interface Capture {
  readonly capturedBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly complete: boolean;
  readonly truncated: boolean;
}

/** A COHERENT capture of `text`: decodable, correctly sized, correctly digested, complete and
 *  untruncated. Cases derive their hostile variants FROM this, so whatever they break is the
 *  only thing broken and the earlier layers provably cannot answer. */
export function capture(text: string): Capture {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({
    capturedBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    complete: true,
    truncated: false,
  });
}

/** A well-formed provider run reference: exactly the keys `snapshotRunRef` accepts. Every
 *  telemetry case that is NOT about the input layer carries this, so `TELEMETRY_INPUT` cannot
 *  answer first and the arranged layer is provably the one that did. */
export const GOOD_RUN_REF = Object.freeze({
  runRef: "run-hostile-0001",
  effectIntentId: "intent-hostile-0001",
  attemptRef: "attempt-hostile-0001",
});

/** One well-formed claude stream line. `type`/`subtype` are what the parser frames on. */
export const initLine = (model: string): string =>
  JSON.stringify({ type: "system", subtype: "init", model });

export const resultLine = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "result", subtype: "success", ...extra });

/** Two init records naming DIFFERENT models: admitted records that disagree, which is a
 *  distinct fact from no record naming a model at all. */
export const AMBIGUOUS_STREAM = `${initLine("claude-a")}\n${initLine("claude-b")}\n${resultLine()}`;

/** Interleaved and out of order: a terminal result before the stream that produced it. */
export const OUT_OF_ORDER_STREAM = `${resultLine()}\n${initLine("claude-a")}`;

/** A record claiming a schema this parser version does not accept. */
export const UNSUPPORTED_SCHEMA_STREAM = JSON.stringify({
  type: "system",
  subtype: "init",
  schemaVersion: "moe-claude-stream/99",
  model: "claude-a",
});

/**
 * Record a telemetry refusal. `layer` is REQUIRED and taken from the boundary's own vocabulary
 * at the case: five layers can answer this seam, and the contract's own comment says a
 * code-only assertion "would stay green once a different layer started answering first".
 */
export function refusedTelemetry(
  ledger: Ledger,
  boundary: string,
  arm: Arm,
  actual: unknown,
  code: string,
  layer: ProviderTelemetryLayer,
): void {
  ledger.refused(boundary, arm, actual, { code, layer });
}

/**
 * Record a LAYER-ATTRIBUTED refusal read off a render manifest.
 *
 * The excluded layer entry is production's own layered refusal: `exclusionReason` is the stable
 * code and `layer` is the answering layer, both minted by the renderer. The ACTUAL passed to
 * the ledger is assembled from those two production fields only — nothing here is hand-written
 * on both sides, so the assertion cannot pass by tautology.
 */
export const ADVISORY_EXCLUDED = "ADVISORY_LAYER_EXCEEDS_CONTEXT_BOUND";

export function refusedByManifestLayer(
  ledger: Ledger,
  boundary: string,
  arm: Arm,
  entry: unknown,
  expectedLayer: string,
): void {
  const manifest = entry as Record<string, unknown>;
  // The bytes were EXCLUDED, not admitted, and the layer carrying them claims no authority.
  expect(manifest["authority"]).toBe("NONE");
  expect(manifest["included"]).toBe(false);
  ledger.refused(
    boundary,
    arm,
    { code: manifest["exclusionReason"], layer: manifest["layer"] },
    { code: ADVISORY_EXCLUDED, layer: expectedLayer },
  );
}

/**
 * Record a refusal from a surface that reports NO layer of its own.
 *
 * Both render contracts are exactly that by production design: `claudeFailure`/`codexFailure`
 * return `{ok, code, message}` and the layer vocabulary lives on the accepted envelope's
 * manifest instead. The absence is ASSERTED rather than assumed, so a layer that starts being
 * reported reddens here and forces the case to pin it; and every such boundary ALSO carries a
 * manifest-attributed case above, so its layer vocabulary is never left unexercised.
 */
export function refusedWithoutLayer(
  ledger: Ledger,
  boundary: string,
  arm: Arm,
  actual: unknown,
  expectedCode: string,
): void {
  const record = actual as Record<string, unknown>;
  expect(record["ok"]).toBe(false);
  expect(record["code"]).toBe(expectedCode);
  expect(record["layer"] ?? record["reasonLayer"]).toBeUndefined();
  // No envelope at all: a refused render must not hand back a partially rendered one.
  expect(record["rendered"]).toBeUndefined();
  ledger.record(boundary, arm, String(record["message"] ?? ""));
}

/** An advisory skill snapshot. Cases mutate ONE field so the gate above the one under test
 *  cannot answer: version, then advisory-authority, then task ref, then bounds. */
export const skillSnapshot = (overrides: Record<string, unknown> = {}): unknown => ({
  rendererInputVersion: "moe-skill-renderer-input/1",
  authority: "NONE",
  advisoryOnly: true,
  skills: [],
  ...overrides,
});

export const renderInput = (overrides: Record<string, unknown> = {}): unknown => ({
  agentsContractBytes: Buffer.from("AGENTS", "utf8"),
  taskContext: { taskRef: "task-hostile", bodyBytes: Buffer.from("BODY", "utf8") },
  skillSnapshot: skillSnapshot(),
  contextLimit: { kind: "CONSERVATIVE_INPUT_BYTES", bytes: 4_096 },
  tokenizer: null,
  ...overrides,
});

/** Hostile values re-checked by the message-hygiene property. */
export const POISON_PATH = "C:\\Users\\forged\\provider\\stdout.jsonl";
export const POISON_DIGEST = "a".repeat(64);
export const LAUNCH_SECRETS: readonly string[] = Object.freeze([
  POISON_PATH,
  POISON_DIGEST,
  "claude-a",
  "SUPER_SECRET_TOKEN_VALUE",
]);
