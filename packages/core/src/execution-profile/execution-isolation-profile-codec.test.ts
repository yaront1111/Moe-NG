import { describe, expect, it } from "vitest";

import * as isolation from "./execution-isolation-profile-codec.js";

const hex = (digit: string): string => digit.repeat(64);
const BUILD_MOUNTS = Object.freeze([
  { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 1_073_741_824 },
  { access: "READ_WRITE", kind: "RUN_SCRATCH", maxBytes: 2_147_483_648 },
  { access: "READ_WRITE", kind: "OUTPUT", maxBytes: 1_073_741_824 },
  { access: "READ_WRITE", kind: "EVIDENCE", maxBytes: 536_870_912 },
]);
const FRESH_MOUNTS = Object.freeze([
  { access: "READ_ONLY", kind: "SOURCE_SNAPSHOT", maxBytes: 1_073_741_824 },
  { access: "WRITE_ONLY", kind: "EVIDENCE", maxBytes: 536_870_912 },
]);
const FORBIDDEN_HOST_INPUTS = Object.freeze([
  "HOST_GIT_METADATA",
  "HOST_GIT_CREDENTIALS",
  "HOST_GIT_CONFIG",
  "GITHUB_CREDENTIALS",
  "SSH_KEY_MATERIAL",
  "SSH_AGENT_SOCKET",
  "PACKAGE_MANAGER_CREDENTIALS",
  "USER_HOME_DIRECTORY",
  "GLOBAL_USER_CONFIGURATION",
  "RAW_PROVIDER_SECRETS",
  "HOST_SECRETS",
  "HOST_CONFIG",
  "HOST_FILESYSTEM",
  "BROAD_HOST_MOUNTS",
  "OTHER_PROJECT_PATHS",
  "OTHER_WORKTREE_PATHS",
  "DAEMON_SOCKET",
  "STORE_SOCKET",
  "CONTROL_SOCKET",
  "DOCKER_SOCKET",
  "DOCKER_WINDOWS_NAMED_PIPE",
  "DOCKER_DAEMON",
]);
const PLANE_IDENTITIES = Object.freeze([
  "CONTROL",
  "PROVIDER",
  "QUALIFICATION_BUILD",
  "RESEARCH",
  "PRODUCT_PREVIEW",
  "PRODUCT_PRODUCTION",
  "TRUSTED_GITHUB_PUBLISHER",
]);

function endpointPolicy(purpose = "BUILD_AGENT", plane = "PROVIDER") {
  return {
    endpointPolicyDigest: hex("e"),
    endpointPolicyRef: "network-policy:provider-build",
    plane,
    purpose,
  };
}

function draft(): Record<string, unknown> {
  return {
    commandMode: "DIRECT_ARGV",
    credentialBroker: {
      brokerRef: "broker:provider-session",
      maximumCredentialTtlMs: 60_000,
    },
    deliveryProfileRevisionDigest: hex("a"),
    executionPlane: isolation.EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE,
    forbiddenHostInputs: [...FORBIDDEN_HOST_INPUTS],
    image: { imageDigest: `sha256:${hex("b")}`, imageRef: "image:node24" },
    limits: {
      cpuMilliCores: 2_000,
      memoryBytes: 2_147_483_648,
      outputBytes: 67_108_864,
      pids: 256,
      wallTimeMs: 600_000,
    },
    mounts: BUILD_MOUNTS.map((mount) => ({ ...mount })),
    network: {
      accessMode: "BROKER_ONLY",
      endpointPolicies: [endpointPolicy()],
      plane: "PROVIDER",
    },
    profileId: "execution-profile-default",
    purpose: "BUILD_AGENT",
    revisionId: "execution-profile-default-r1",
    sourceSnapshotDigest: hex("c"),
    tools: [{ toolDigest: hex("d"), toolRef: "tool:node" }],
  };
}

function freshDraft(): Record<string, unknown> {
  return {
    ...draft(),
    credentialBroker: null,
    mounts: FRESH_MOUNTS.map((mount) => ({ ...mount })),
    network: {
      accessMode: "NONE",
      endpointPolicies: [endpointPolicy("FRESH_VERIFIER", "QUALIFICATION_BUILD")],
      plane: "QUALIFICATION_BUILD",
    },
    profileId: "execution-profile-fresh-verifier",
    purpose: "FRESH_VERIFIER",
    revisionId: "execution-profile-fresh-verifier-r1",
  };
}

function created(value: unknown = draft()) {
  const result = isolation.createExecutionIsolationProfileRevision(value);
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

const policyRefusal = {
  code: "EXECUTION_ISOLATION_PROFILE_NETWORK_INVALID",
  layer: "EXECUTION_ISOLATION_PROFILE_NETWORK",
  ok: false,
};

describe("ExecutionIsolationProfileRevision policy", () => {
  it("separates isolation purpose, network plane identity, and network access mode", () => {
    const surface = isolation as unknown as Record<string, unknown>;
    expect(surface["EXECUTION_ISOLATION_PROFILE_PURPOSES"])
      .toEqual(["BUILD_AGENT", "FRESH_VERIFIER"]);
    expect(surface["EXECUTION_ISOLATION_NETWORK_PLANE_IDENTITIES"])
      .toEqual(PLANE_IDENTITIES);
    expect(surface["EXECUTION_ISOLATION_NETWORK_ACCESS_MODES"])
      .toEqual(["NONE", "BROKER_ONLY", "ALLOWLISTED_EGRESS"]);
    expect(isolation.createExecutionIsolationProfileRevision(draft()).ok).toBe(true);
    expect(isolation.createExecutionIsolationProfileRevision(freshDraft()).ok).toBe(true);
    expect(isolation.createExecutionIsolationProfileRevision({
      ...draft(), purpose: "GENERAL_EXECUTION",
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_PURPOSE_INVALID",
      layer: "EXECUTION_ISOLATION_PROFILE_PURPOSE",
      ok: false,
    });
  });

  it("pins disposable Docker Linux as default and Hyper-V isolation as the only Windows plane", () => {
    expect(isolation.EXECUTION_ISOLATION_PROFILE_DEFAULT_PLANE)
      .toBe("DISPOSABLE_DOCKER_LINUX");
    expect(isolation.EXECUTION_ISOLATION_PROFILE_PLANES).toEqual([
      "DISPOSABLE_DOCKER_LINUX",
      "HYPER_V_ISOLATED_WINDOWS_CONTAINER",
    ]);
    expect(isolation.createExecutionIsolationProfileRevision({
      ...draft(), executionPlane: "HYPER_V_ISOLATED_WINDOWS_CONTAINER",
    }).ok).toBe(true);
    expect(isolation.createExecutionIsolationProfileRevision({
      ...draft(), executionPlane: "WINDOWS_PROCESS_CONTAINER",
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_PLANE_FORBIDDEN",
      layer: "EXECUTION_ISOLATION_PROFILE_PLANE",
      ok: false,
    });
  });

  it("gives fresh verifiers only read-only source and writable evidence with no broker", () => {
    const fresh = created(freshDraft());
    expect(fresh.mounts).toEqual(FRESH_MOUNTS);
    expect(fresh.credentialBroker).toBeNull();
    expect(fresh.network).toMatchObject({ accessMode: "NONE", plane: "QUALIFICATION_BUILD" });

    expect(isolation.createExecutionIsolationProfileRevision({
      ...freshDraft(),
      mounts: FRESH_MOUNTS.map((mount, index) => index === 1
        ? { ...mount, access: "READ_WRITE" } : mount),
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_MOUNT_FORBIDDEN",
      layer: "EXECUTION_ISOLATION_PROFILE_MOUNTS",
      ok: false,
    });

    expect(isolation.createExecutionIsolationProfileRevision({
      ...freshDraft(), mounts: BUILD_MOUNTS,
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_MOUNT_FORBIDDEN",
      layer: "EXECUTION_ISOLATION_PROFILE_MOUNTS",
      ok: false,
    });
    expect(isolation.createExecutionIsolationProfileRevision({
      ...freshDraft(), credentialBroker: draft()["credentialBroker"],
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER_INVALID",
      layer: "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER",
      ok: false,
    });
    expect(isolation.createExecutionIsolationProfileRevision({
      ...freshDraft(),
      network: {
        accessMode: "NONE",
        endpointPolicies: [endpointPolicy("FRESH_VERIFIER", "CONTROL")],
        plane: "CONTROL",
      },
    })).toEqual(policyRefusal);
  });

  it("retains bounded scratch/output only for build agents and pins per-mount byte ceilings", () => {
    const build = created();
    expect(build.mounts).toEqual(BUILD_MOUNTS);
    expect(build.credentialBroker).not.toBeNull();
    expect(Object.isFrozen(build.mounts[0])).toBe(true);

    for (const mounts of [
      BUILD_MOUNTS.slice(0, 3),
      BUILD_MOUNTS.map((mount, index) => index === 0
        ? { ...mount, access: "READ_WRITE" } : mount),
      [...BUILD_MOUNTS, { access: "READ_WRITE", kind: "HOST_FILESYSTEM", maxBytes: 1 }],
    ]) {
      expect(isolation.createExecutionIsolationProfileRevision({ ...draft(), mounts })).toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_MOUNT_FORBIDDEN",
        layer: "EXECUTION_ISOLATION_PROFILE_MOUNTS",
        ok: false,
      });
    }
    for (const maxBytes of [0, 274_877_906_945]) {
      const mounts = BUILD_MOUNTS.map((mount, index) => index === 1
        ? { ...mount, maxBytes } : mount);
      expect(isolation.createExecutionIsolationProfileRevision({ ...draft(), mounts })).toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED",
        layer: "EXECUTION_ISOLATION_PROFILE_LIMITS",
        ok: false,
      });
    }
    expect(isolation.createExecutionIsolationProfileRevision({
      ...draft(), commandMode: "SHELL_COMMAND",
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_COMMAND_MODE_FORBIDDEN",
      layer: "EXECUTION_ISOLATION_PROFILE_COMMAND",
      ok: false,
    });
  });

  it("requires the expanded exact forbidden host-input roster without exemptions", () => {
    expect(isolation.EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS)
      .toEqual(FORBIDDEN_HOST_INPUTS);
    expect(Object.isFrozen(isolation.EXECUTION_ISOLATION_PROFILE_FORBIDDEN_HOST_INPUTS)).toBe(true);
    for (const forbidden of FORBIDDEN_HOST_INPUTS) {
      expect(isolation.createExecutionIsolationProfileRevision({
        ...draft(),
        forbiddenHostInputs: FORBIDDEN_HOST_INPUTS.filter((candidate) => candidate !== forbidden),
      })).toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_HOST_INPUT_FORBIDDEN",
        layer: "EXECUTION_ISOLATION_PROFILE_HOST_BOUNDARY",
        ok: false,
      });
    }
    for (const forbiddenHostInputs of [
      [...FORBIDDEN_HOST_INPUTS, "HOST_TEMP_DIRECTORY"],
      [...FORBIDDEN_HOST_INPUTS.slice(0, -1), FORBIDDEN_HOST_INPUTS[0]],
      [FORBIDDEN_HOST_INPUTS[1], FORBIDDEN_HOST_INPUTS[0], ...FORBIDDEN_HOST_INPUTS.slice(2)],
    ]) {
      expect(isolation.createExecutionIsolationProfileRevision({
        ...draft(), forbiddenHostInputs,
      })).toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_HOST_INPUT_FORBIDDEN",
        layer: "EXECUTION_ISOLATION_PROFILE_HOST_BOUNDARY",
        ok: false,
      });
    }
  });

  it("requires purpose-bound immutable endpoint policies instead of opaque endpoint refs", () => {
    const hostileNetworks = [
      { accessMode: "ALLOWLISTED_EGRESS", endpointPolicies: ["endpoint:anything"], plane: "PROVIDER" },
      {
        accessMode: "BROKER_ONLY",
        endpointPolicies: [endpointPolicy("FRESH_VERIFIER", "PROVIDER")],
        plane: "PROVIDER",
      },
      {
        accessMode: "BROKER_ONLY",
        endpointPolicies: [endpointPolicy("BUILD_AGENT", "CONTROL")],
        plane: "PROVIDER",
      },
      {
        accessMode: "BROKER_ONLY",
        endpointPolicies: [{ ...endpointPolicy(), endpointPolicyDigest: "mutable" }],
        plane: "PROVIDER",
      },
    ];
    for (const network of hostileNetworks) {
      expect(isolation.createExecutionIsolationProfileRevision({ ...draft(), network }))
        .toEqual(policyRefusal);
    }
    for (const endpointPolicies of [[], [endpointPolicy(), endpointPolicy()]]) {
      expect(isolation.createExecutionIsolationProfileRevision({
        ...draft(), network: { accessMode: "BROKER_ONLY", endpointPolicies, plane: "PROVIDER" },
      })).toEqual(policyRefusal);
    }
    expect(isolation.createExecutionIsolationProfileRevision({
      ...draft(),
      network: {
        accessMode: "BROKER_ONLY",
        endpointPolicies: Array.from(
          { length: isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxEndpointPolicies + 1 },
          (_, index) => ({
            ...endpointPolicy(), endpointPolicyRef: `network-policy:p${String(index).padStart(3, "0")}`,
          }),
        ),
        plane: "PROVIDER",
      },
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED",
      layer: "EXECUTION_ISOLATION_PROFILE_LIMITS",
      ok: false,
    });
  });

  it("requires a short-lived opaque broker only for build agents", () => {
    for (const credentialBroker of [
      null,
      { brokerRef: "sk-live-raw-provider-secret", maximumCredentialTtlMs: 60_000 },
      { brokerRef: "/var/run/docker.sock", maximumCredentialTtlMs: 60_000 },
      { brokerRef: "broker:provider-session", maximumCredentialTtlMs: 900_001 },
    ]) {
      expect(isolation.createExecutionIsolationProfileRevision({ ...draft(), credentialBroker }))
        .toEqual({
          code: "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER_INVALID",
          layer: "EXECUTION_ISOLATION_PROFILE_CREDENTIAL_BROKER",
          ok: false,
        });
    }
  });

  it("enforces CPU, memory, PID, wall-time, and output ceilings", () => {
    for (const [field, value] of [
      ["cpuMilliCores", isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxCpuMilliCores + 1],
      ["memoryBytes", isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxMemoryBytes + 1],
      ["pids", isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxPids + 1],
      ["wallTimeMs", isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxWallTimeMs + 1],
      ["outputBytes", isolation.EXECUTION_ISOLATION_PROFILE_LIMITS.maxOutputBytes + 1],
    ] as const) {
      const limits = { ...(draft()["limits"] as Record<string, number>), [field]: value };
      expect(isolation.createExecutionIsolationProfileRevision({ ...draft(), limits })).toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_LIMIT_EXCEEDED",
        layer: "EXECUTION_ISOLATION_PROFILE_LIMITS",
        ok: false,
      });
    }
  });

  it("deeply freezes and digest-binds purpose, policies, mounts, source, profile, image, and tools", () => {
    const revision = created();
    expect(revision.revisionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision.network.endpointPolicies[0])).toBe(true);
    expect(Object.isFrozen(revision.mounts)).toBe(true);
    const mutations = [
      { deliveryProfileRevisionDigest: hex("1") },
      { sourceSnapshotDigest: hex("2") },
      { image: { imageDigest: `sha256:${hex("3")}`, imageRef: "image:node24" } },
      { tools: [{ toolDigest: hex("4"), toolRef: "tool:node" }] },
      { mounts: BUILD_MOUNTS.map((mount, index) => index === 3
        ? { ...mount, maxBytes: mount.maxBytes - 1 } : mount) },
      { network: {
        accessMode: "BROKER_ONLY",
        endpointPolicies: [{ ...endpointPolicy(), endpointPolicyDigest: hex("5") }],
        plane: "PROVIDER",
      } },
    ];
    for (const mutation of mutations) {
      expect(created({ ...draft(), ...mutation }).revisionDigest).not.toBe(revision.revisionDigest);
    }
    expect(created(freshDraft()).revisionDigest).not.toBe(revision.revisionDigest);
  });
});

describe("ExecutionIsolationProfileRevision codec", () => {
  it("round-trips exact canonical bytes and refuses version/digest mutation", () => {
    const revision = created();
    const encoded = isolation.encodeExecutionIsolationProfileRevision(revision);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(isolation.decodeExecutionIsolationProfileRevisionBytes(encoded.bytes))
      .toEqual({ ok: true, revision });
    expect(isolation.decodeExecutionIsolationProfileRevisionBytes(new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(encoded.bytes)), null, 2),
    ))).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_NONCANONICAL",
      layer: "EXECUTION_ISOLATION_PROFILE_CANONICALIZATION",
      ok: false,
    });
    expect(isolation.decodeExecutionIsolationProfileRevisionBytes(new TextEncoder().encode(
      new TextDecoder().decode(encoded.bytes).replace(revision.revisionDigest, hex("9")),
    ))).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_DIGEST_MISMATCH",
      layer: "EXECUTION_ISOLATION_PROFILE_DIGEST",
      ok: false,
    });
    expect(isolation.encodeExecutionIsolationProfileRevision({
      ...revision, version: "moe-execution-isolation-profile-revision/2",
    })).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_VERSION_UNSUPPORTED",
      layer: "EXECUTION_ISOLATION_PROFILE_VERSION",
      ok: false,
    });
  });

  it("refuses hostile shapes, duplicate keys, invalid bytes, and oversized bytes exactly", () => {
    const missing = draft(); delete missing["sourceSnapshotDigest"];
    expect(isolation.createExecutionIsolationProfileRevision(missing)).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_MALFORMED",
      layer: "EXECUTION_ISOLATION_PROFILE_ADMISSION",
      ok: false,
    });
    const cyclic = draft(); cyclic["cycle"] = cyclic;
    expect(isolation.createExecutionIsolationProfileRevision(cyclic)).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_MALFORMED",
      layer: "EXECUTION_ISOLATION_PROFILE_ADMISSION",
      ok: false,
    });
    expect(isolation.decodeExecutionIsolationProfileRevisionBytes(new TextEncoder().encode(
      "{\"profileId\":\"a\",\"profileId\":\"b\"}",
    ))).toEqual({
      code: "EXECUTION_ISOLATION_PROFILE_DUPLICATE_KEY",
      layer: "EXECUTION_ISOLATION_PROFILE_CODEC",
      ok: false,
    });
    expect(isolation.decodeExecutionIsolationProfileRevisionBytes(new Uint8Array([0xff])))
      .toEqual({
        code: "EXECUTION_ISOLATION_PROFILE_BYTES_INVALID",
        layer: "EXECUTION_ISOLATION_PROFILE_CODEC",
        ok: false,
      });
  });
});
