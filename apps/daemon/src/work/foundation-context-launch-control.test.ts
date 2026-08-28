import { Buffer } from "node:buffer";

import { DEFAULT_CONTEXT_BYTE_BUDGET, renderContext, selectContext } from "@moe/context";
import type { ClaudeLaunchRequest } from "@moe/runner";
import { describe, expect, it } from "vitest";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import {
  DAEMON_FOUNDATION_ATTEMPT, launchRequestBody,
} from "./foundation-attempt-contracts.js";
import type {
  FoundationAttemptBound, FoundationAttemptLaunchTemplate, FoundationAttemptRefused,
} from "./foundation-attempt-contracts.js";
import type { FoundationContextSealed } from "./foundation-context-record.js";
import { produceLaunchTemplateFields } from "./launch-template-producer.js";

const DIGEST = "a".repeat(64);
const REQUEST_KEYS = [
  "runtime", "duplicateDelivery", "effect", "attempt", "grant", "claim",
  "wrapperIdentity", "bootstrapCredentialDigest", "priorRegistration", "argv", "cwd",
  "environment", "reconciliation", "limits", "renderedContext", "contextManifestDigest",
  "launchSelection",
] as const satisfies readonly (keyof ClaudeLaunchRequest)[];
const CROSS_BINDING_FAULTS = ["bytes", "digest"] as const;

const RECORD = {
  attempt: { attemptId: "attempt-1" }, effectIntent: { intentId: "intent-1" },
  grant: { wrapperIdentity: DIGEST },
} as unknown as ActivationLedgerRecord;
const BOUND = { claim: { claimId: "claim-1" } } as unknown as FoundationAttemptBound;
const RUNTIME = {} as unknown as ClaudeLaunchRequest["runtime"];
const CALLER: FoundationAttemptLaunchTemplate = Object.freeze({
  argv: ["caller", "--wrong"], bootstrapCredentialDigest: DIGEST, cwd: "D:\\caller",
  environment: { CALLER: "wrong" }, launchSelection: { caller: true },
  limits: { caller: true },
  runtime: { installedRoot: "D:\\runtime", pinRoot: "D:\\pins", quotedObservation: {} },
});

type BuildLaunchBody = (
  record: ActivationLedgerRecord, bound: FoundationAttemptBound, context: FoundationContextSealed,
  caller: Pick<FoundationAttemptLaunchTemplate, "bootstrapCredentialDigest" | "cwd">,
  runtime: ClaudeLaunchRequest["runtime"],
) => ClaudeLaunchRequest | FoundationAttemptRefused;

function sealedContext(content = "ASCII e\u0301 \u6f22 \ud83d\ude00"): FoundationContextSealed {
  const selected = selectContext({
    byteBudget: DEFAULT_CONTEXT_BYTE_BUDGET, exclusions: [],
    mandatory: [{ content, id: "mission-1", kind: "MANDATORY", section: "mission" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`selection refused: ${selected.code}`);
  const produced = produceLaunchTemplateFields({
    capabilities: {
      authority: "DAEMON_VERIFIED", capabilitySchemaDigest: DIGEST, concurrencyCeiling: 1,
      configurationDigest: DIGEST, evidence: "DURABLE",
      limits: { stderrBytes: 64, stdoutBytes: 64, tailBytes: 32, timeoutMs: 1_000 },
      modelSnapshotEvidence: "claude-cli-2.0.14-2026-05-01",
      modelSnapshotKind: "DATED_SNAPSHOT", ok: true, orchestrationDigest: DIGEST,
      outcome: "CURRENT", policyDigest: DIGEST, profileRevisionId: "profile-1",
      reasoningEffort: "high", selectedModelId: "claude-opus-5",
    },
    mission: { instructions: content, test: "pnpm test", title: "Foundation", workspace: "D:\\work" },
    renderedContext: renderContext(selected.selection),
    runtimeObservation: {
      adapterCapabilitySchemaDigest: DIGEST, platformIdentity: "windows", reportedVersion: "2.0.14",
    },
  });
  if (!produced.ok) throw new Error(`template refused: ${produced.code}@${produced.layer}`);
  return Object.freeze({
    bytes: produced.renderedContext.bytes,
    contextManifestDigest: produced.renderedContext.manifest.digest, ok: true, template: produced,
  });
}

function build(
  context: FoundationContextSealed, caller = CALLER,
): ClaudeLaunchRequest | FoundationAttemptRefused {
  return (launchRequestBody as unknown as BuildLaunchBody)(RECORD, BOUND, context, caller, RUNTIME);
}

function accepted(context: FoundationContextSealed): ClaudeLaunchRequest {
  const result = build(context);
  if (!("runtime" in result)) throw new Error(`${result.code}@${result.refusedBy}`);
  return result;
}

describe("Foundation launch body carries only the durable sealed context", () => {
  it("uses sealed authority fields instead of divergent caller fields", () => {
    const context = sealedContext();
    const body = accepted(context);
    expect(body.argv).toBe(context.template.argv);
    expect(body.environment).toBe(context.template.environment);
    expect(body.limits).toBe(context.template.limits);
    expect(body.launchSelection).toBe(context.template.launchSelection);
    expect(body.argv).not.toEqual(CALLER.argv);
  });

  it("carries the durable digest and exact multibyte bytes in the runner key set", () => {
    const context = sealedContext();
    const body = accepted(context);
    expect(body.contextManifestDigest).toBe(context.contextManifestDigest);
    expect(Buffer.from(body.renderedContext, "utf8")).toEqual(Buffer.from(context.bytes));
    expect(Object.keys(body).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(REQUEST_KEYS).toHaveLength(17);
    expect(CROSS_BINDING_FAULTS).toHaveLength(2);
  });

  it("refuses invalid UTF-8 under the daemon attempt layer", () => {
    const original = sealedContext();
    const bytes = Object.freeze([0xc3, 0x28]);
    const context: FoundationContextSealed = Object.freeze({
      ...original, bytes,
      template: Object.freeze({
        ...original.template,
        renderedContext: Object.freeze({ ...original.template.renderedContext, bytes }),
      }),
    });
    expect(build(context)).toEqual({
      advisoryOnly: true, authority: "NONE",
      code: "FOUNDATION_ATTEMPT_CONTEXT_BYTES_UNDELIVERABLE", ok: false,
      refusedBy: DAEMON_FOUNDATION_ATTEMPT,
    });
  });

  it.each(CROSS_BINDING_FAULTS)(
    "refuses a context whose template %s is foreign",
    (fault) => {
      const original = sealedContext();
      const renderedContext = fault === "bytes"
        ? Object.freeze({ ...original.template.renderedContext, bytes: Object.freeze([0x61]) })
        : Object.freeze({
          ...original.template.renderedContext,
          manifest: Object.freeze({ ...original.template.renderedContext.manifest, digest: "b".repeat(64) }),
        });
      const context: FoundationContextSealed = Object.freeze({
        ...original, template: Object.freeze({ ...original.template, renderedContext }),
      });
      expect(build(context)).toEqual({
        advisoryOnly: true, authority: "NONE",
        code: "FOUNDATION_ATTEMPT_CONTEXT_TEMPLATE_UNBOUND", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    },
  );
});
