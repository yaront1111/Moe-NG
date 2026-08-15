// @ts-check
import { createHash, createPublicKey, KeyObject } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { createCompatGate } from "../../packages/control-room-client/src/index.js";
import {
  buildDistributionContainer,
  publicKeyHex,
} from "../../tools/packaging/distribution-build.ts";
import { startDistribution } from "../../tools/packaging/distribution-startup.ts";

/** @typedef {import("../../tools/packaging/distribution-build.ts").DistributionBuildInput["componentKind"]} ComponentKind */
/** @typedef {{assets: readonly string[], componentId: string, componentKind: ComponentKind}} ReleaseComponent */
/** @typedef {{objectFormat: "sha1" | "sha256", sourceSha: string}} ReleaseSource */
/** @typedef {{components?: unknown, privateKey: KeyObject, signingKeyId: string, source: unknown, sourceRoot: string}} ReleaseSubjectDraft */
/** @typedef {{bytes: Uint8Array, templateId: string, version: string}} ReleaseTemplate */
/** @typedef {Extract<import("../../tools/packaging/distribution-build.ts").DistributionBuildResult, {ok: true}>} AcceptedBuild */

export const RELEASE_SUPPLY_CHAIN_CODE = "RELEASE_SUPPLY_CHAIN_REFUSED";
export const RELEASE_SUPPLY_CHAIN_LAYER = "RELEASE_SUPPLY_CHAIN";
export const RELEASE_REFUSAL_REASONS = Object.freeze([
  "SOURCE_PROVENANCE_INVALID", "RELEASE_INVENTORY_EMPTY", "RELEASE_INPUT_INVALID",
  "SOURCE_ASSET_UNAVAILABLE", "CONTROL_ROOM_COMPATIBILITY_REFUSED",
  "FROZEN_INSTALL_FAILED", "SBOM_GENERATION_FAILED", "DEPENDENCY_AUDIT_FAILED",
  "LICENSE_REPORT_FAILED", "SBOM_REPORT_INVALID", "DEPENDENCY_AUDIT_INVALID",
  "LICENSE_REPORT_INVALID", "SUPPORTED_OS_EVIDENCE_MISSING", "REPRODUCIBILITY_MISMATCH",
  "TOOLCHAIN_IDENTITY_MISMATCH", "TOOLCHAIN_OBSERVATION_FAILED",
  "EVIDENCE_PUBLICATION_CONFLICT", "CLI_ARGUMENT_INVALID", "OUTPUT_PATH_INVALID",
  "EVIDENCE_WRITE_INTERRUPTED",
]);

const CLAUDE_ASSETS = Object.freeze([
  "claude-cancel-reconcile.ts", "claude-capabilities.ts", "claude-observation.ts",
  "claude-probe.ts", "claude-render.ts", "claude-runtime-pin-closure.ts",
  "claude-runtime-pin-copy.ts", "claude-runtime-pin-fs.ts", "claude-runtime-pin.ts",
  "claude-stream-anomalies.ts", "claude-stream.ts",
].map((name) => `packages/runner/src/providers/claude/${name}`));
const CODEX_ASSETS = Object.freeze([
  "codex-cancel-reconcile.ts", "codex-capabilities.ts", "codex-observation.ts",
  "codex-probe.ts", "codex-render-skills.ts", "codex-render.ts",
  "codex-stream-anomalies.ts", "codex-stream.ts",
].map((name) => `packages/runner/src/providers/codex/${name}`));

export const RELEASE_COMPONENTS = Object.freeze([
  Object.freeze({ assets: Object.freeze(["apps/daemon/src/index.ts"]), componentId: "daemon", componentKind: "DAEMON" }),
  Object.freeze({ assets: Object.freeze(["apps/control-room/index.html"]), componentId: "control-room", componentKind: "CONTROL_ROOM" }),
  Object.freeze({ assets: Object.freeze(["packages/mcp/src/index.ts"]), componentId: "mcp-bridge", componentKind: "MCP_BRIDGE" }),
  Object.freeze({ assets: CLAUDE_ASSETS, componentId: "provider-claude", componentKind: "PROVIDER_ADAPTER" }),
  Object.freeze({ assets: CODEX_ASSETS, componentId: "provider-codex", componentKind: "PROVIDER_ADAPTER" }),
]);
export const RELEASE_TEMPLATES = Object.freeze(["AGENTS.md", "CLAUDE.md", ".codex/agent-instructions.md"]);

const CONTRACT = Object.freeze({
  apiCompatibilityRange: Object.freeze({
    commandEnvelopeVersion: "moe-runtime-command/1",
    errorRegistryVersion: "moe-runtime-error-registry/1",
    queryEnvelopeVersion: "moe-runtime-query/1",
  }),
  buildToolVersions: Object.freeze({ node: "24.16.0", pnpm: "11.0.8" }),
  contractSchemaHash: "1d96f39e6399ce63090405ca6168175540cce1c783154a52007a8905eaa47106",
});

const sha256 = (/** @type {Uint8Array} */ bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function releaseRefusal(/** @type {string} */ reason) {
  return Object.freeze({
    code: RELEASE_SUPPLY_CHAIN_CODE,
    ok: false,
    reason,
    refusedBy: RELEASE_SUPPLY_CHAIN_LAYER,
  });
}

function exactRecord(/** @type {unknown} */ value, /** @type {readonly string[]} */ keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const own = Object.keys(value).sort();
    const expected = [...keys].sort();
    return own.length === expected.length && own.every((key, index) => key === expected[index]);
  } catch { return false; }
}

/** @returns {value is ReleaseSource} */
function validSource(/** @type {unknown} */ value) {
  if (!exactRecord(value, ["objectFormat", "sourceSha"])) return false;
  const source = /** @type {{objectFormat?: unknown, sourceSha?: unknown}} */ (value);
  if (source.objectFormat !== "sha1" && source.objectFormat !== "sha256") return false;
  const length = source.objectFormat === "sha1" ? 40 : 64;
  return typeof source.sourceSha === "string"
    && source.sourceSha.length === length && /^[0-9a-f]+$/u.test(source.sourceSha);
}

function selectedComponents(/** @type {unknown} */ value) {
  if (value === undefined) return RELEASE_COMPONENTS;
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return /** @type {readonly ReleaseComponent[]} */ (value);
  return JSON.stringify(value) === JSON.stringify(RELEASE_COMPONENTS) ? RELEASE_COMPONENTS : undefined;
}

function readOwned(/** @type {string} */ root, /** @type {string} */ logicalPath) {
  const file = resolve(root, ...logicalPath.split("/"));
  const relativeFile = relative(root, file);
  if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) throw new Error("path escape");
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  const realRelative = relative(realRoot, realFile);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) throw new Error("symlink escape");
  return new Uint8Array(readFileSync(realFile));
}

function immutableComponent(/** @type {AcceptedBuild} */ built) {
  return Object.freeze({
    assetDigests: Object.freeze(built.manifest.assets.map((/** @type {{sha256: string}} */ asset) => asset.sha256)),
    componentId: built.manifest.componentId,
    componentKind: built.manifest.componentKind,
    containerBytes: built.containerBytes,
    containerDigest: sha256(built.containerBytes),
    manifestBytes: built.manifestBytes,
    manifestDigest: sha256(built.manifestBytes),
  });
}

function buildOne(
  /** @type {ReleaseComponent} */ component,
  /** @type {ReleaseSubjectDraft & {source: ReleaseSource}} */ input,
  /** @type {ReleaseTemplate[]} */ templates,
) {
  const assets = component.assets.map((/** @type {string} */ path) => ({
    bytes: readOwned(input.sourceRoot, path), path,
  }));
  return buildDistributionContainer({
    apiCompatibilityRange: CONTRACT.apiCompatibilityRange,
    assets,
    buildToolVersions: CONTRACT.buildToolVersions,
    builtInSkillManifestBytes: [],
    componentId: component.componentId,
    componentKind: component.componentKind,
    contractSchemaHash: CONTRACT.contractSchemaHash,
    instructionTemplates: templates,
    signingKeyId: input.signingKeyId,
    source: input.source,
  }, input.privateKey);
}

function inputParts(/** @type {unknown} */ value) {
  if (!exactRecord(value, ["components", "privateKey", "signingKeyId", "source", "sourceRoot"])
    && !exactRecord(value, ["privateKey", "signingKeyId", "source", "sourceRoot"])) return undefined;
  const input = /** @type {Record<string, unknown>} */ (value);
  const components = selectedComponents(input.components);
  if (!components || typeof input.sourceRoot !== "string" || !isAbsolute(input.sourceRoot)
    || typeof input.signingKeyId !== "string" || !(input.privateKey instanceof KeyObject)
    || input.privateKey.type !== "private") return undefined;
  return { components, input: /** @type {ReleaseSubjectDraft} */ ({
    components: input.components,
    privateKey: input.privateKey,
    signingKeyId: input.signingKeyId,
    source: input.source,
    sourceRoot: input.sourceRoot,
  }) };
}

/** Build and admit the exact release subject without publishing or launching it. */
export function buildReleaseSubject(/** @type {unknown} */ value) {
  const parts = inputParts(value);
  if (!parts) return releaseRefusal("RELEASE_INPUT_INVALID");
  if (!validSource(parts.input.source)) return releaseRefusal("SOURCE_PROVENANCE_INVALID");
  const input = { ...parts.input, source: parts.input.source };
  if (parts.components.length === 0) return releaseRefusal("RELEASE_INVENTORY_EMPTY");
  try {
    const templates = RELEASE_TEMPLATES.map((templateId) => ({
      bytes: readOwned(input.sourceRoot, templateId), templateId, version: "1",
    }));
    if (templates.length === 0 || parts.components.some((entry) => entry.assets.length === 0)) {
      return releaseRefusal("RELEASE_INVENTORY_EMPTY");
    }
    const built = parts.components.map((component) => buildOne(component, input, templates));
    const refused = built.find((entry) => !entry.ok);
    if (refused) return refused;
    const accepted = /** @type {AcceptedBuild[]} */ (built);
    const compatible = accepted.map((entry) => createCompatGate({
      apiCompatibilityRange: entry.manifest.apiCompatibilityRange,
      assetDigest: entry.manifest.aggregateDigest,
      buildToolVersions: entry.manifest.buildToolVersions,
      contractSchemaHash: entry.manifest.contractSchemaHash,
      sourceSha: entry.manifest.source.sourceSha,
    }));
    if (compatible.some((entry) => !entry.ok)) return releaseRefusal("CONTROL_ROOM_COMPATIBILITY_REFUSED");
    const publicKey = createPublicKey(input.privateKey);
    const keyHex = publicKeyHex(publicKey);
    /** @type {string[]} */
    const launched = [];
    const receipt = startDistribution({
      containers: accepted.map((entry) => entry.containerBytes),
      expectation: {
        apiCompatibilityRange: CONTRACT.apiCompatibilityRange,
        buildToolVersions: CONTRACT.buildToolVersions,
        builtInSkills: [],
        componentKinds: Object.fromEntries(parts.components.map((entry) => [entry.componentId, entry.componentKind])),
        contractSchemaHash: CONTRACT.contractSchemaHash,
        instructionTemplates: templates.map((entry) => ({ digest: sha256(entry.bytes), templateId: entry.templateId, version: entry.version })),
        source: input.source,
        trustedKeyIds: [input.signingKeyId],
      },
      trustedPublicKeys: { [input.signingKeyId]: keyHex },
    }, (componentId) => launched.push(componentId));
    if (!receipt.ok) return receipt;
    return Object.freeze({
      componentCount: accepted.length,
      containers: Object.freeze(accepted.map(immutableComponent)),
      ok: true,
      receipt: Object.freeze({
        admittedComponentIds: receipt.launched,
        compatibleComponentIds: Object.freeze(parts.components.map((entry) => entry.componentId)),
        launchReceipts: Object.freeze(launched.map((componentId) => Object.freeze({ componentId, physicallyLaunched: false }))),
        verificationKey: Object.freeze({ keyId: input.signingKeyId, publicKeyHex: keyHex }),
      }),
      source: Object.freeze({ ...input.source }),
      templateCount: templates.length,
      verificationKeyUse: "EPHEMERAL_VERIFICATION_ONLY",
    });
  } catch { return releaseRefusal("SOURCE_ASSET_UNAVAILABLE"); }
}
