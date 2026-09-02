import { describe, expect, it } from "vitest";

import * as isolation from "./execution-isolation-profile-codec.js";
import * as recipeSurface from "./verification-recipe-codec.js";

import {
  VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS,
  VERIFICATION_RECIPE_DIGEST_DOMAIN,
  VERIFICATION_RECIPE_LIMITS,
  VERIFICATION_RECIPE_NETWORK_ACCESS_MODES,
  VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES,
  VERIFICATION_RECIPE_VERSION,
  createVerificationRecipeRevision,
  decodeVerificationRecipeRevisionBytes,
  encodeVerificationRecipeRevision,
} from "./verification-recipe-codec.js";

const hex = (digit: string): string => digit.repeat(64);

function draft(): Record<string, unknown> {
  return {
    argv: ["--run", "test:unit"],
    environmentNameAllowlist: ["CI", "MOE_EVIDENCE_DIR"],
    evidenceParser: {
      parserRef: "evidence-parser:vitest-json",
      revisionDigest: hex("f"),
    },
    executionProfileRevisionDigest: hex("a"),
    expectedExitCode: 0,
    expectedOutputs: [{
      mount: "EVIDENCE",
      relativePath: "reports/unit.json",
      sha256: hex("b"),
    }],
    expectedRefusal: null,
    image: { imageDigest: `sha256:${hex("c")}`, imageRef: "image:node24" },
    networkPolicy: {
      accessMode: "NONE",
      plane: "QUALIFICATION_BUILD",
      policyRef: "network-policy:qualification-verifier",
      revisionDigest: hex("1"),
    },
    recipeId: "verify-unit",
    resourceCaps: {
      cpuMilliCores: 2_000,
      memoryBytes: 4_294_967_296,
      outputBytes: 268_435_456,
      pids: 256,
      timeoutMs: 600_000,
    },
    revisionId: "verify-unit-r1",
    sourceSnapshotDigest: hex("d"),
    tool: { toolDigest: hex("e"), toolRef: "tool:node" },
    workingDirectory: "packages/core",
  };
}

function created(value: unknown = draft()) {
  const result = createVerificationRecipeRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function executionProfile(purpose: "BUILD_AGENT" | "FRESH_VERIFIER") {
  const fresh = purpose === "FRESH_VERIFIER";
  const result = isolation.createExecutionIsolationProfileRevision({
    commandMode: "DIRECT_ARGV",
    credentialBroker: fresh ? null : {
      brokerRef: "broker:provider-session", maximumCredentialTtlMs: 60_000,
    },
    deliveryProfileRevisionDigest: hex("9"),
    executionPlane: "DISPOSABLE_DOCKER_LINUX",
    forbiddenHostInputs: [...isolation.EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS],
    image: { imageDigest: `sha256:${hex("c")}`, imageRef: "image:node24" },
    limits: {
      cpuMilliCores: 4_000, memoryBytes: 8_589_934_592,
      outputBytes: 536_870_912, pids: 512, wallTimeMs: 1_200_000,
    },
    mounts: fresh ? [
      { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 1_073_741_824 },
      { access: "WRITE_ONLY", kind: "EVIDENCE", maxBytes: 536_870_912 },
    ] : [
      { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 1_073_741_824 },
      { access: "READ_WRITE", kind: "RUN_SCRATCH", maxBytes: 2_147_483_648 },
      { access: "READ_WRITE", kind: "OUTPUT", maxBytes: 1_073_741_824 },
      { access: "READ_WRITE", kind: "EVIDENCE", maxBytes: 536_870_912 },
    ],
    network: {
      accessMode: "NONE",
      endpointPolicies: [{
        endpointPolicyDigest: hex("1"),
        endpointPolicyRef: "network-policy:qualification-verifier",
        plane: "QUALIFICATION_BUILD",
        purpose,
      }],
      plane: "QUALIFICATION_BUILD",
    },
    profileId: fresh ? "fresh-verifier" : "build-agent",
    purpose,
    revisionId: fresh ? "fresh-verifier-r1" : "build-agent-r1",
    sourceSnapshotDigest: hex("d"),
    tools: [{ toolDigest: hex("e"), toolRef: "tool:node" }],
  });
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

type CrossAdmission = (
  recipe: unknown,
  executionProfile: unknown,
) => Readonly<{ code?: string; layer?: string; ok: boolean }>;

function crossAdmission(): CrossAdmission | undefined {
  const candidate = (recipeSurface as unknown as Record<string, unknown>)[
    "admitVerificationRecipeForExecutionProfile"
  ];
  expect(typeof candidate).toBe("function");
  return typeof candidate === "function" ? candidate as CrossAdmission : undefined;
}

describe("VerificationRecipeRevision policy", () => {
  it("binds source, profile, tool, image, execution policy, parser, and direct argv", () => {
    const revision = created();
    expect(revision.version).toBe(VERIFICATION_RECIPE_VERSION);
    expect(revision.revisionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.argv)).toBe(true);
    expect(Object.isFrozen(revision.expectedOutputs[0])).toBe(true);

    const mutations = [
      { sourceSnapshotDigest: hex("1") },
      { executionProfileRevisionDigest: hex("2") },
      { tool: { toolDigest: hex("3"), toolRef: "tool:node" } },
      { image: { imageDigest: `sha256:${hex("4")}`, imageRef: "image:node24" } },
      { argv: ["--run", "test:integration"] },
      { workingDirectory: "packages/daemon" },
      { environmentNameAllowlist: ["CI", "NO_COLOR"] },
      { networkPolicy: {
        accessMode: "NONE", plane: "QUALIFICATION_BUILD",
        policyRef: "network-policy:qualification-verifier", revisionDigest: hex("2"),
      } },
      { resourceCaps: {
        cpuMilliCores: 2_000, memoryBytes: 4_294_967_296,
        outputBytes: 268_435_456, pids: 256, timeoutMs: 600_001,
      } },
      { evidenceParser: {
        parserRef: "evidence-parser:vitest-json", revisionDigest: hex("3"),
      } },
    ];
    for (const mutation of mutations) {
      expect(created({ ...draft(), ...mutation }).revisionDigest).not.toBe(revision.revisionDigest);
    }
  });

  it("requires a canonical repository-relative working directory", () => {
    expect(createVerificationRecipeRevision({ ...draft(), workingDirectory: "." }).ok).toBe(true);
    for (const workingDirectory of [
      "", "/packages/core", "../core", "packages/../core", "packages\\core",
      "C:/repo", "packages//core", "packages/./core",
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), workingDirectory })).toEqual({
        code: "VERIFICATION_RECIPE_WORKING_DIRECTORY_INVALID",
        layer: "VERIFICATION_RECIPE_WORKING_DIRECTORY",
        ok: false,
      });
    }
    expect(createVerificationRecipeRevision({
      ...draft(), workingDirectory: "x".repeat(VERIFICATION_RECIPE_LIMITS.maxWorkingDirectoryBytes + 1),
    })).toEqual({
      code: "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
      layer: "VERIFICATION_RECIPE_LIMITS",
      ok: false,
    });
  });

  it("pins an exact sorted environment-name allowlist", () => {
    expect(createVerificationRecipeRevision({ ...draft(), environmentNameAllowlist: [] }).ok)
      .toBe(true);
    for (const environmentNameAllowlist of [
      ["MOE_EVIDENCE_DIR", "CI"], ["CI", "CI"], ["CI", "bad-name"], ["CI", 7],
    ]) {
      expect(createVerificationRecipeRevision({
        ...draft(), environmentNameAllowlist,
      })).toEqual({
        code: "VERIFICATION_RECIPE_ENVIRONMENT_INVALID",
        layer: "VERIFICATION_RECIPE_ENVIRONMENT",
        ok: false,
      });
    }
    expect(createVerificationRecipeRevision({
      ...draft(),
      environmentNameAllowlist: Array.from(
        { length: VERIFICATION_RECIPE_LIMITS.maxEnvironmentNames + 1 },
        (_, index) => `V_${String(index).padStart(3, "0")}`,
      ),
    })).toEqual({
      code: "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
      layer: "VERIFICATION_RECIPE_LIMITS",
      ok: false,
    });
    expect(createVerificationRecipeRevision({
      ...draft(),
      environmentNameAllowlist: [
        "A".repeat(VERIFICATION_RECIPE_LIMITS.maxEnvironmentNameBytes + 1),
      ],
    })).toEqual({
      code: "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
      layer: "VERIFICATION_RECIPE_LIMITS",
      ok: false,
    });
  });

  it("admits only closed purpose-specific safe environment-name rosters", () => {
    const surface = recipeSurface as unknown as Record<string, unknown>;
    expect(surface["VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES"]).toEqual([
      "CI", "MOE_EVIDENCE_DIR", "MOE_OUTPUT_DIR", "MOE_SCRATCH_DIR", "NO_COLOR",
    ]);
    expect(surface["VERIFICATION_RECIPE_FRESH_VERIFIER_SAFE_ENVIRONMENT_NAMES"]).toEqual([
      "CI", "MOE_EVIDENCE_DIR", "NO_COLOR",
    ]);
    expect(Object.isFrozen(
      surface["VERIFICATION_RECIPE_BUILD_AGENT_SAFE_ENVIRONMENT_NAMES"],
    )).toBe(true);
    for (const environmentName of [
      "DOCKER_HOST",
      "GITHUB_TOKEN",
      "HOME",
      "SSH_AUTH_SOCK",
      "AWS_SECRET_ACCESS_KEY",
      "GIT_CREDENTIAL_HELPER",
      "MOE_DAEMON_SOCKET",
      "NPM_CONFIG_USERCONFIG",
      "PATH",
      "XDG_CONFIG_HOME",
    ]) {
      expect(createVerificationRecipeRevision({
        ...draft(), environmentNameAllowlist: [environmentName],
      })).toEqual({
        code: "VERIFICATION_RECIPE_ENVIRONMENT_FORBIDDEN",
        layer: "VERIFICATION_RECIPE_ENVIRONMENT",
        ok: false,
      });
    }
  });

  it("resolves the environment roster from the bound profile purpose", () => {
    const admitBound = crossAdmission(); if (admitBound === undefined) return;
    const buildProfile = executionProfile("BUILD_AGENT");
    const freshProfile = executionProfile("FRESH_VERIFIER");
    const buildRecipe = created({
      ...draft(), environmentNameAllowlist: ["MOE_OUTPUT_DIR"],
      executionProfileRevisionDigest: buildProfile.revisionDigest,
    });
    const freshRecipe = created({
      ...draft(), environmentNameAllowlist: ["MOE_OUTPUT_DIR"],
      executionProfileRevisionDigest: freshProfile.revisionDigest,
    });
    expect(admitBound(buildRecipe, buildProfile).ok).toBe(true);
    expect(admitBound(freshRecipe, freshProfile)).toEqual({
      code: "VERIFICATION_RECIPE_ENVIRONMENT_FORBIDDEN",
      layer: "VERIFICATION_RECIPE_ENVIRONMENT",
      ok: false,
    });
  });

  it("cross-admits expected outputs against the exact writable profile mounts", () => {
    const admitBound = crossAdmission(); if (admitBound === undefined) return;
    const buildProfile = executionProfile("BUILD_AGENT");
    const freshProfile = executionProfile("FRESH_VERIFIER");
    const forProfile = (profile: { readonly revisionDigest: string }, mount: string) => created({
      ...draft(),
      executionProfileRevisionDigest: profile.revisionDigest,
      expectedOutputs: [{ mount, relativePath: "reports/unit.json", sha256: hex("b") }],
    });
    expect(admitBound(forProfile(freshProfile, "EVIDENCE"), freshProfile).ok).toBe(true);
    expect(admitBound(forProfile(buildProfile, "OUTPUT"), buildProfile).ok).toBe(true);
    expect(admitBound(forProfile(freshProfile, "OUTPUT"), freshProfile)).toEqual({
      code: "VERIFICATION_RECIPE_OUTPUT_MOUNT_UNAVAILABLE",
      layer: "VERIFICATION_RECIPE_OUTPUT",
      ok: false,
    });
    const freshEvidence = forProfile(freshProfile, "EVIDENCE");
    expect(admitBound(freshEvidence, {
      ...freshProfile, revisionDigest: hex("0"),
    })).toEqual({
      code: "VERIFICATION_RECIPE_EXECUTION_PROFILE_MISMATCH",
      layer: "VERIFICATION_RECIPE_EXECUTION_PROFILE",
      ok: false,
    });
    expect(admitBound({ ...freshEvidence, revisionDigest: hex("0") }, freshProfile)).toEqual({
      code: "VERIFICATION_RECIPE_DIGEST_MISMATCH",
      layer: "VERIFICATION_RECIPE_DIGEST",
      ok: false,
    });
  });

  it("binds an immutable network policy to access mode and plane identity", () => {
    expect(VERIFICATION_RECIPE_NETWORK_ACCESS_MODES)
      .toEqual(["NONE", "BROKER_ONLY", "ALLOWLISTED_EGRESS"]);
    expect(VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES).toEqual([
      "CONTROL", "PROVIDER", "QUALIFICATION_BUILD", "RESEARCH", "PRODUCT_PREVIEW",
      "PRODUCT_PRODUCTION", "TRUSTED_GITHUB_PUBLISHER",
    ]);
    expect(Object.isFrozen(VERIFICATION_RECIPE_NETWORK_PLANE_IDENTITIES)).toBe(true);
    for (const networkPolicy of [
      { ...draft()["networkPolicy"] as object, accessMode: "ENDPOINT_ANYTHING" },
      { ...draft()["networkPolicy"] as object, plane: "BROKER_ONLY" },
      { ...draft()["networkPolicy"] as object, policyRef: "endpoint:anything" },
      { ...draft()["networkPolicy"] as object, revisionDigest: "not-a-digest" },
      { ...draft()["networkPolicy"] as object, extra: true },
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), networkPolicy })).toEqual({
        code: "VERIFICATION_RECIPE_NETWORK_POLICY_INVALID",
        layer: "VERIFICATION_RECIPE_NETWORK_POLICY",
        ok: false,
      });
    }
  });

  it("requires bounded resource caps and an immutable evidence-parser revision", () => {
    const caps = draft()["resourceCaps"] as Record<string, unknown>;
    for (const resourceCaps of [
      { ...caps, cpuMilliCores: 0 },
      { ...caps, memoryBytes: VERIFICATION_RECIPE_LIMITS.maxMemoryBytes + 1 },
      { ...caps, outputBytes: VERIFICATION_RECIPE_LIMITS.maxOutputBytes + 1 },
      { ...caps, pids: VERIFICATION_RECIPE_LIMITS.maxPids + 1 },
      { ...caps, timeoutMs: VERIFICATION_RECIPE_LIMITS.maxTimeoutMs + 1 },
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), resourceCaps })).toEqual({
        code: "VERIFICATION_RECIPE_RESOURCE_CAP_INVALID",
        layer: "VERIFICATION_RECIPE_RESOURCE_CAPS",
        ok: false,
      });
    }
    for (const evidenceParser of [
      { parserRef: "tool:vitest-json", revisionDigest: hex("f") },
      { parserRef: "evidence-parser:vitest-json", revisionDigest: "not-a-digest" },
      { parserRef: "evidence-parser:vitest-json", revisionDigest: hex("f"), extra: true },
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), evidenceParser })).toEqual({
        code: "VERIFICATION_RECIPE_EVIDENCE_PARSER_INVALID",
        layer: "VERIFICATION_RECIPE_EVIDENCE_PARSER",
        ok: false,
      });
    }
  });

  it("rejects every shell tool and command-shaped substitution at the exact shell fence", () => {
    expect(VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS).toEqual([
      "sh", "bash", "dash", "zsh", "fish", "cmd", "cmd.exe",
      "powershell", "powershell.exe", "pwsh", "wsl", "wsl.exe",
    ]);
    expect(Object.isFrozen(VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS)).toBe(true);
    for (const shell of VERIFICATION_RECIPE_FORBIDDEN_SHELL_TOOLS) {
      expect(createVerificationRecipeRevision({
        ...draft(), tool: { toolDigest: hex("e"), toolRef: `tool:${shell}` },
      })).toEqual({
        code: "VERIFICATION_RECIPE_SHELL_FORBIDDEN",
        layer: "VERIFICATION_RECIPE_COMMAND",
        ok: false,
      });
    }
    for (const toolRef of [
      "tool:PowerShell.exe", "/bin/bash", "C:\\Windows\\System32\\cmd.exe",
    ]) {
      expect(createVerificationRecipeRevision({
        ...draft(), tool: { toolDigest: hex("e"), toolRef },
      })).toEqual({
        code: "VERIFICATION_RECIPE_SHELL_FORBIDDEN",
        layer: "VERIFICATION_RECIPE_COMMAND",
        ok: false,
      });
    }
    const command: Record<string, unknown> = {
      ...draft(), command: "pnpm test && publish",
    };
    delete command["argv"];
    expect(createVerificationRecipeRevision(command)).toEqual({
      code: "VERIFICATION_RECIPE_MALFORMED",
      layer: "VERIFICATION_RECIPE_ADMISSION",
      ok: false,
    });
  });

  it("requires one explicit success or refusal outcome without ambiguity", () => {
    expect(createVerificationRecipeRevision({
      ...draft(), expectedExitCode: null, expectedOutputs: [],
      expectedRefusal: { code: "POLICY_DENIED", layer: "POLICY" },
    }).ok).toBe(true);
    for (const outcome of [
      { expectedExitCode: 0, expectedOutputs: [], expectedRefusal: null },
      {
        expectedExitCode: 0,
        expectedOutputs: draft()["expectedOutputs"],
        expectedRefusal: { code: "POLICY_DENIED", layer: "POLICY" },
      },
      { expectedExitCode: null, expectedOutputs: draft()["expectedOutputs"], expectedRefusal: null },
      { expectedExitCode: null, expectedOutputs: [], expectedRefusal: null },
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), ...outcome })).toEqual({
        code: "VERIFICATION_RECIPE_OUTCOME_INVALID",
        layer: "VERIFICATION_RECIPE_OUTCOME",
        ok: false,
      });
    }
  });

  it("keeps expected outputs relative to output/evidence mounts", () => {
    for (const expectedOutputs of [
      [{ mount: "SOURCE_SNAPSHOT", relativePath: "report.json", sha256: hex("b") }],
      [{ mount: "EVIDENCE", relativePath: "../report.json", sha256: hex("b") }],
      [{ mount: "OUTPUT", relativePath: "C:\\report.json", sha256: hex("b") }],
      [{ mount: "OUTPUT", relativePath: "/report.json", sha256: hex("b") }],
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), expectedOutputs })).toEqual({
        code: "VERIFICATION_RECIPE_OUTPUT_INVALID",
        layer: "VERIFICATION_RECIPE_OUTPUT",
        ok: false,
      });
    }
  });

  it("bounds argv count/bytes, outputs, and output paths", () => {
    for (const mutation of [
      { argv: Array.from({ length: VERIFICATION_RECIPE_LIMITS.maxArgs + 1 }, () => "x") },
      { argv: ["x".repeat(VERIFICATION_RECIPE_LIMITS.maxArgBytes + 1)] },
      {
        expectedOutputs: Array.from(
          { length: VERIFICATION_RECIPE_LIMITS.maxOutputs + 1 },
          (_, index) => ({
            mount: "EVIDENCE", relativePath: `report-${String(index)}.json`, sha256: hex("b"),
          }),
        ),
      },
      { expectedOutputs: [{
        mount: "EVIDENCE",
        relativePath: `reports/${"x".repeat(VERIFICATION_RECIPE_LIMITS.maxOutputPathBytes)}`,
        sha256: hex("b"),
      }] },
    ]) {
      expect(createVerificationRecipeRevision({ ...draft(), ...mutation })).toEqual({
        code: "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
        layer: "VERIFICATION_RECIPE_LIMITS",
        ok: false,
      });
    }
  });
});

describe("VerificationRecipeRevision codec", () => {
  it("pins the revision version and digest domain and refuses another version exactly", () => {
    expect(VERIFICATION_RECIPE_VERSION).toBe("moe-verification-recipe-revision/1");
    expect(VERIFICATION_RECIPE_DIGEST_DOMAIN)
      .toBe("moe-verification-recipe-revision-digest/1");
    expect(encodeVerificationRecipeRevision({
      ...created(), version: "moe-verification-recipe-revision/2",
    })).toEqual({
      code: "VERIFICATION_RECIPE_VERSION_UNSUPPORTED",
      layer: "VERIFICATION_RECIPE_VERSION",
      ok: false,
    });
  });

  it("round-trips only canonical bytes and detects digest mutation", () => {
    const revision = created();
    const encoded = encodeVerificationRecipeRevision(revision);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeVerificationRecipeRevisionBytes(encoded.bytes)).toEqual({ ok: true, revision });
    expect(decodeVerificationRecipeRevisionBytes(new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(encoded.bytes)), null, 2),
    ))).toEqual({
      code: "VERIFICATION_RECIPE_NONCANONICAL",
      layer: "VERIFICATION_RECIPE_CANONICALIZATION",
      ok: false,
    });
    expect(decodeVerificationRecipeRevisionBytes(new TextEncoder().encode(
      new TextDecoder().decode(encoded.bytes).replace(revision.revisionDigest, hex("9")),
    ))).toEqual({
      code: "VERIFICATION_RECIPE_DIGEST_MISMATCH",
      layer: "VERIFICATION_RECIPE_DIGEST",
      ok: false,
    });
  });

  it("refuses hostile shapes, duplicate keys, invalid bytes, and oversized bytes exactly", () => {
    const missing = draft(); delete missing["sourceSnapshotDigest"];
    expect(createVerificationRecipeRevision(missing)).toEqual({
      code: "VERIFICATION_RECIPE_MALFORMED",
      layer: "VERIFICATION_RECIPE_ADMISSION",
      ok: false,
    });
    expect(createVerificationRecipeRevision({ ...draft(), shell: true })).toEqual({
      code: "VERIFICATION_RECIPE_MALFORMED",
      layer: "VERIFICATION_RECIPE_ADMISSION",
      ok: false,
    });
    const cyclic = draft(); cyclic["cycle"] = cyclic;
    expect(createVerificationRecipeRevision(cyclic)).toEqual({
      code: "VERIFICATION_RECIPE_MALFORMED",
      layer: "VERIFICATION_RECIPE_ADMISSION",
      ok: false,
    });
    expect(decodeVerificationRecipeRevisionBytes(new TextEncoder().encode(
      "{\"recipeId\":\"a\",\"recipeId\":\"b\"}",
    ))).toEqual({
      code: "VERIFICATION_RECIPE_DUPLICATE_KEY",
      layer: "VERIFICATION_RECIPE_CODEC",
      ok: false,
    });
    expect(decodeVerificationRecipeRevisionBytes(new Uint8Array([0xff]))).toEqual({
      code: "VERIFICATION_RECIPE_BYTES_INVALID",
      layer: "VERIFICATION_RECIPE_CODEC",
      ok: false,
    });
    expect(decodeVerificationRecipeRevisionBytes(
      new Uint8Array(VERIFICATION_RECIPE_LIMITS.maxBytes + 1),
    )).toEqual({
      code: "VERIFICATION_RECIPE_LIMIT_EXCEEDED",
      layer: "VERIFICATION_RECIPE_LIMITS",
      ok: false,
    });
  });
});
