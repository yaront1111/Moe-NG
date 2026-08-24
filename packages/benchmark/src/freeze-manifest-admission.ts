import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  FREEZE_MANIFEST_SCHEMA_VERSION, canonicalizeConfirmatoryFreezeManifest,
  decodeConfirmatoryFreezeManifest, type ConfirmatoryFreezeManifest,
  type ConfirmatoryFreezeManifestContractRefusal,
} from "./freeze-manifest-contracts.js";
import {
  isPinnedDocument, readPinnedBenchmarkSpec, readPinnedRebuildDesign,
  type PinnedDocument,
} from "./pre-freeze-pinned-documents.js";
import type { PreFreezeAuditRefusal } from "./pre-freeze-audit-vocabulary.js";

export const CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES = Object.freeze([
  "CONFIRMATORY_FREEZE_MANIFEST_MISSING",
  "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED",
  "CONFIRMATORY_FREEZE_MANIFEST_STALE",
  "CONFIRMATORY_FREEZE_MANIFEST_CONFLICTING",
  "CONFIRMATORY_FREEZE_MANIFEST_FOREIGN",
  "CONFIRMATORY_FREEZE_MANIFEST_DIRTY_TREE",
  "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH",
  "CONFIRMATORY_FREEZE_MANIFEST_HORIZON_MOVED",
  "CONFIRMATORY_FREEZE_MANIFEST_IMPLEMENTATION_SHA_MISMATCH",
] as const);

export type ConfirmatoryFreezeManifestAdmissionCode =
  (typeof CONFIRMATORY_FREEZE_MANIFEST_ADMISSION_CODES)[number];

export type ConfirmatoryFreezeManifestAdmissionRefusal = {
  readonly ok: false;
  readonly code: ConfirmatoryFreezeManifestAdmissionCode;
  readonly layer: "CONFIRMATORY_FREEZE_MANIFEST_ADMISSION";
  readonly sourceCode: string;
  readonly sourceLayer: string;
  readonly message: string;
};

export type ConfirmatoryFreezeManifestAdmission =
  | {
    readonly ok: true;
    readonly manifest: ConfirmatoryFreezeManifest;
    readonly manifestSha256: string;
    readonly custody: {
      readonly status: "UNATTESTED";
      readonly attestedCustody: "UNKNOWN";
    };
  }
  | ConfirmatoryFreezeManifestAdmissionRefusal;

export type ConfirmatoryFreezeCampaignIdentityInput = {
  readonly schemaVersion: typeof FREEZE_MANIFEST_SCHEMA_VERSION;
  readonly campaignLabel: string;
  readonly implementationSha: string;
  readonly designSha256: string;
  readonly benchmarkSha256: string;
};

type GitHorizon = { readonly head: string; readonly status: string };
type GitRefusal = { readonly code: string; readonly layer: "CONFIRMATORY_FREEZE_GIT" };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const deriveConfirmatoryFreezeCampaignId = (
  input: ConfirmatoryFreezeCampaignIdentityInput,
): string => sha256(JSON.stringify({
  schemaVersion: input.schemaVersion,
  campaignLabel: input.campaignLabel,
  implementationSha: input.implementationSha,
  designSha256: input.designSha256,
  benchmarkSha256: input.benchmarkSha256,
}));

export const deriveConfirmatoryFreezeManifestRegistryRef = (
  campaignId: string,
): string => `sha256:${sha256(JSON.stringify({
  kind: "confirmatory-freeze-manifest", campaignId,
}))}`;

const admissionRefusal = (
  code: ConfirmatoryFreezeManifestAdmissionCode,
  sourceCode: string,
  sourceLayer: string,
): ConfirmatoryFreezeManifestAdmissionRefusal => Object.freeze({
  ok: false,
  code,
  layer: "CONFIRMATORY_FREEZE_MANIFEST_ADMISSION",
  sourceCode,
  sourceLayer,
  message: "confirmatory freeze manifest admission refused",
});

const decodeGit = (value: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(value);

const gitOutput = (args: readonly string[]): string => decodeGit(execFileSync("git", [...args], {
  windowsHide: true,
  timeout: 5_000,
  maxBuffer: 64 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
}));

const captureGitHorizon = (): GitHorizon | GitRefusal => {
  try {
    const head = gitOutput(["rev-parse", "--verify", "HEAD"]).trim();
    const status = gitOutput(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("unreadable git head");
    return Object.freeze({ head, status });
  } catch {
    return Object.freeze({
      code: "CONFIRMATORY_FREEZE_GIT_UNREADABLE", layer: "CONFIRMATORY_FREEZE_GIT",
    });
  }
};

const wrapContract = (
  source: ConfirmatoryFreezeManifestContractRefusal,
): ConfirmatoryFreezeManifestAdmissionRefusal =>
  admissionRefusal(source.code, source.code, source.layer);

const moved = (before: GitHorizon, after: GitHorizon): boolean =>
  before.head !== after.head || before.status !== after.status;

const readPins = (): readonly [
  PinnedDocument | PreFreezeAuditRefusal,
  PinnedDocument | PreFreezeAuditRefusal,
] => [readPinnedRebuildDesign(), readPinnedBenchmarkSpec()];

const bindingRefusal = (
  manifest: ConfirmatoryFreezeManifest,
  design: PinnedDocument,
  benchmark: PinnedDocument,
): ConfirmatoryFreezeManifestAdmissionRefusal | null => {
  const designBinding = manifest.bindings.find(({ kind }) => kind === "DESIGN")?.sha256;
  const benchmarkBinding = manifest.bindings.find(({ kind }) => kind === "BENCHMARK")?.sha256;
  if (designBinding === design.source.sha256 && benchmarkBinding === benchmark.source.sha256) {
    return null;
  }
  return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH",
    "CONFIRMATORY_FREEZE_BINDING_MISMATCH",
    "CONFIRMATORY_FREEZE_MANIFEST_BINDINGS",
  );
};

const campaignRefusal = (
  manifest: ConfirmatoryFreezeManifest,
  design: PinnedDocument,
  benchmark: PinnedDocument,
): ConfirmatoryFreezeManifestAdmissionRefusal | null => {
  const campaignId = deriveConfirmatoryFreezeCampaignId({
    schemaVersion: manifest.schemaVersion,
    campaignLabel: manifest.campaignLabel,
    implementationSha: manifest.implementationSha,
    designSha256: design.source.sha256,
    benchmarkSha256: benchmark.source.sha256,
  });
  const registryRef = deriveConfirmatoryFreezeManifestRegistryRef(campaignId);
  if (manifest.campaignId === campaignId && manifest.manifestRegistryRef === registryRef) return null;
  return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH",
    "CONFIRMATORY_FREEZE_REGISTRY_MISMATCH",
    "CONFIRMATORY_FREEZE_MANIFEST_IDENTITY",
  );
};

const identityRefusal = (
  manifest: ConfirmatoryFreezeManifest,
  horizon: GitHorizon,
  design: PinnedDocument,
  benchmark: PinnedDocument,
): ConfirmatoryFreezeManifestAdmissionRefusal | null => {
  if (manifest.projectId !== "moe-next") {
    return admissionRefusal(
      "CONFIRMATORY_FREEZE_MANIFEST_FOREIGN",
      "CONFIRMATORY_FREEZE_PROJECT_FOREIGN",
      "CONFIRMATORY_FREEZE_MANIFEST_IDENTITY",
    );
  }
  if (manifest.implementationSha !== horizon.head) {
    return admissionRefusal(
      "CONFIRMATORY_FREEZE_MANIFEST_IMPLEMENTATION_SHA_MISMATCH",
      "CONFIRMATORY_FREEZE_GIT_IMPLEMENTATION_MISMATCH",
      "CONFIRMATORY_FREEZE_GIT",
    );
  }
  return bindingRefusal(manifest, design, benchmark) ?? campaignRefusal(manifest, design, benchmark);
};

export const admitConfirmatoryFreezeManifest = (
  input: unknown,
): ConfirmatoryFreezeManifestAdmission => {
  const decoded = decodeConfirmatoryFreezeManifest(input);
  if (!decoded.ok) return wrapContract(decoded);
  const before = captureGitHorizon();
  if ("code" in before) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", before.code, before.layer,
  );
  const [design, benchmark] = readPins();
  const after = captureGitHorizon();
  if ("code" in after) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_MALFORMED", after.code, after.layer,
  );
  if (moved(before, after)) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_HORIZON_MOVED",
    "CONFIRMATORY_FREEZE_GIT_HORIZON_MOVED", "CONFIRMATORY_FREEZE_GIT",
  );
  if (before.status.length > 0) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_DIRTY_TREE",
    "CONFIRMATORY_FREEZE_GIT_DIRTY", "CONFIRMATORY_FREEZE_GIT",
  );
  if (!isPinnedDocument(design)) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH", design.code, design.layer,
  );
  if (!isPinnedDocument(benchmark)) return admissionRefusal(
    "CONFIRMATORY_FREEZE_MANIFEST_REGISTRY_MISMATCH", benchmark.code, benchmark.layer,
  );
  const identityFailure = identityRefusal(decoded.manifest, before, design, benchmark);
  if (identityFailure) return identityFailure;
  const manifestSha256 = sha256(canonicalizeConfirmatoryFreezeManifest(decoded.manifest));
  const custody = Object.freeze({ status: "UNATTESTED", attestedCustody: "UNKNOWN" } as const);
  return Object.freeze({ ok: true, manifest: decoded.manifest, manifestSha256, custody });
};
