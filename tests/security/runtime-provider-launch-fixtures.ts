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

import type { ClaudeTelemetryHandoff } from "../../packages/runner/src/providers/telemetry/claude-telemetry-launch.js";
import type { ProviderTelemetryLayer } from "../../packages/runner/src/providers/telemetry/provider-telemetry-contracts.js";
import { refusedWithoutLayer } from "./runtime-provider-ledger.js";
import type { Arm, Ledger } from "./runtime-provider-ledger.js";

/** Re-exported so the render cases import their two recorders from one place. */
export { refusedWithoutLayer };

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
  provider: "claude",
  runRef: "run-hostile-0001",
  effectIntentId: "intent-hostile-0001",
  attemptRef: "attempt-hostile-0001",
  epoch: 1,
});

/** A well-formed launch selection: exactly the keys `snapshotLaunchSelection` accepts, with
 *  every digest a real 64-hex. Cases mutate ONE field so the shape gate cannot answer first. */
export const GOOD_SELECTION = Object.freeze({
  provider: "claude",
  selectedModelId: "claude-opus-5",
  modelSnapshotKind: "DATED_SNAPSHOT",
  modelSnapshotEvidence: "2026-05-01",
  reasoningEffort: "high",
  profileRevisionId: "profile-1",
  configurationDigest: "b".repeat(64),
  policyDigest: "c".repeat(64),
  orchestrationDigest: "d".repeat(64),
  concurrencyCeiling: 4,
});

/** One well-formed claude stream record. `seq` and `schemaVersion` are load-bearing: a record
 *  without them is a MALFORMED_RECORD anomaly, which would answer for every case below and make
 *  the deeper layers unreachable. Every stream here is therefore coherent at TELEMETRY_CAPTURE
 *  and at the anomaly analyser unless the case deliberately breaks one thing. */
const SCHEMA_VERSION = "claude-stream-json/1";

export const initLine = (seq: number, model: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq, schemaVersion: SCHEMA_VERSION, type: "system", subtype: "init", model, ...extra });

export const resultLine = (seq: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq, schemaVersion: SCHEMA_VERSION, type: "result", subtype: "success", ...extra });

/** A stream nothing is wrong with. Cases derive from it so what they break is the only thing
 *  broken and the layers above the one under test provably cannot answer. */
export const COHERENT_STREAM = `${initLine(1, "claude-a")}
${resultLine(2, { num_turns: 1 })}
`;

/** Two admitted init records naming DIFFERENT models. The stream PARSES — which is the point:
 *  the model fact stays UNKNOWN rather than one of the two being picked as authority. */
export const AMBIGUOUS_STREAM =
  `${initLine(1, "claude-a")}
${initLine(2, "claude-b")}
${resultLine(3, { num_turns: 1 })}
`;

/** Interleaved: sequence 5 arrives before sequence 3. */
export const OUT_OF_ORDER_STREAM =
  `${initLine(1, "claude-a")}
${resultLine(5, { num_turns: 1 })}
${initLine(3, "claude-a")}
`;

/** A record claiming a schema this parser version does not accept. */
export const UNSUPPORTED_SCHEMA_STREAM =
  `${initLine(1, "claude-a", { schemaVersion: "moe-claude-stream/99" })}
${resultLine(2, { num_turns: 1 })}
`;

/** A record claiming to resume a session this capture never contained. */
export const RESUMED_STREAM =
  `${initLine(1, "claude-a", { resumedFrom: "sess-0" })}
${resultLine(2, { num_turns: 1 })}
`;

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

/** An advisory skill snapshot. Cases mutate ONE field so the gate above the one under test
 *  cannot answer: version, then advisory-authority, then task ref, then bounds. */
export const OVERSIZED_SKILL = Object.freeze({
  skillId: "hostile",
  version: "1",
  origin: "hostile",
  bundleDigest: "e".repeat(64),
  files: Object.freeze([
    Object.freeze({
      path: "big.md",
      sha256: createHash("sha256").update(Buffer.alloc(8_192, 0x61)).digest("hex"),
      byteLength: 8_192,
      contentBase64: Buffer.alloc(8_192, 0x61).toString("base64"),
    }),
  ]),
});

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

/** A provider-run handoff whose interval, sequence and receipt are ALL observed, so the usage
 *  normalizer's earlier arms provably cannot answer. Cases blank exactly one of them. */
export const usageHandoff = (overrides: Record<string, unknown>): ClaudeTelemetryHandoff =>
  ({
    launch: { startedAt: "2026-08-16T00:00:00.000Z", completedAt: "2026-08-16T00:00:01.000Z" },
    sequence: { known: true, value: 1 },
    stdoutReceiptDigest: { known: true, value: POISON_DIGEST },
    providerRunRef: GOOD_RUN_REF,
    tokens: {},
    telemetryRefusal: null,
    ...overrides,
  }) as unknown as ClaudeTelemetryHandoff;

/** Hostile values re-checked by the message-hygiene property. */
export const POISON_PATH = "C:\\Users\\forged\\provider\\stdout.jsonl";
export const POISON_DIGEST = "a".repeat(64);
export const LAUNCH_SECRETS: readonly string[] = Object.freeze([
  POISON_PATH,
  POISON_DIGEST,
  "claude-a",
  "SUPER_SECRET_TOKEN_VALUE",
]);
