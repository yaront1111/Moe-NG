import { describe, expect, it } from "vitest";

import {
  MOE_CLI_NODE_UNSUPPORTED,
  MOE_CONFIG_FILENAME,
  MOE_CONFIG_INVALID,
  MOE_CONFIG_UNREADABLE,
  MOE_INIT_CONFIG_PRESENT,
  MOE_INIT_TARGET_NOT_EMPTY,
  MOE_INIT_TARGET_UNWRITABLE,
  checkNodeVersion,
  parseMoeConfig,
  planInit,
} from "./moe-init.js";
import type { InitInputs, InitResolution } from "./moe-init.js";

const TARGET = "D:/demos/Moe Demo";
const TARGET_PROJECT_ID = "moe-demo-b02c5451986d";

/** The resolver's only nondeterministic input, pinned so a plan is comparable. */
const fixedHex = (bytes: number): string => "7f".repeat(bytes);

function inputs(overrides: Partial<InitInputs> = {}): InitInputs {
  return {
    force: false,
    probe: { entries: [], writable: true },
    randomHex: fixedHex,
    targetDir: TARGET,
    ...overrides,
  };
}

function planned(overrides: Partial<InitInputs> = {}): Extract<InitResolution, { ok: true }> {
  const result = planInit(inputs(overrides));
  if (!result.ok) {
    throw new Error(`expected a plan, got ${result.refusals.map((r) => r.code).join(",")}`);
  }
  return result;
}

function refusedCodes(overrides: Partial<InitInputs> = {}): readonly string[] {
  const result = planInit(inputs(overrides));
  if (result.ok) throw new Error("expected a refusal, got a plan");
  return result.refusals.map((refusal) => refusal.code);
}

describe("planInit produces the config the start command reads back", () => {
  it("places the store beside the config inside the target directory", () => {
    const plan = planned();
    expect(plan.storePath.replaceAll("\\", "/")).toBe(`${TARGET}/store.sqlite`);
    expect(plan.configPath.replaceAll("\\", "/")).toBe(`${TARGET}/${MOE_CONFIG_FILENAME}`);
  });

  it("mints the operator credential from the injected randomness", () => {
    expect(planned().credential).toBe(fixedHex(32));
  });

  it("derives a readable, collision-resistant project id from the canonical Windows path", () => {
    expect(planned().projectId).toMatch(/^moe-demo-[0-9a-f]{12}$/u);
    expect(planned({ targetDir: "D:/other/Moe Demo" }).projectId).not.toBe(planned().projectId);
    expect(planned({ targetDir: "d:\\DEMOS\\Moe Demo" }).projectId).toBe(planned().projectId);
  });

  it("keeps the collision suffix when the leaf sanitizes to nothing", () => {
    expect(planned({ targetDir: "D:/___" }).projectId).toMatch(/^moe-local-[0-9a-f]{12}$/u);
  });

  it("writes exactly one file, the config, with the planned bytes", () => {
    const plan = planned();
    expect(plan.files.map((file) => file.path)).toEqual([plan.configPath]);
    const [file] = plan.files;
    if (file === undefined) throw new Error("unreachable: the config file is always planned");
    expect(file.contents.endsWith("\n")).toBe(true);
    expect(JSON.parse(file.contents)).toEqual({
      credential: fixedHex(32),
      projectId: TARGET_PROJECT_ID,
      schemaVersion: "moe-cli-config/1",
      storePath: plan.storePath,
    });
  });

  it("discloses the credential's provenance without disclosing its value", () => {
    const plan = planned();
    const joined = plan.disclosures.join("\n");
    expect(joined).toContain("MOE_DAEMON_CREDENTIAL=<minted, hidden>");
    expect(joined).not.toContain(plan.credential);
  });

  it("is byte-identical across two runs over identical inputs", () => {
    expect(JSON.stringify(planned())).toBe(JSON.stringify(planned()));
  });
});

describe("planInit refusals name the exact fault", () => {
  it("refuses an unwritable target", () => {
    expect(refusedCodes({ probe: { entries: [], writable: false } }))
      .toEqual([MOE_INIT_TARGET_UNWRITABLE]);
  });

  it("refuses a non-empty target without --force", () => {
    expect(refusedCodes({ probe: { entries: ["notes.txt"], writable: true } }))
      .toEqual([MOE_INIT_TARGET_NOT_EMPTY]);
  });

  it("accepts a non-empty target with --force", () => {
    expect(planned({ force: true, probe: { entries: ["notes.txt"], writable: true } }).projectId)
      .toBe(TARGET_PROJECT_ID);
  });

  it("refuses an existing config even with --force, and names the file", () => {
    const result = planInit(inputs({
      force: true,
      probe: { entries: [MOE_CONFIG_FILENAME], writable: true },
    }));
    if (result.ok) throw new Error("expected a refusal, got a plan");
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([MOE_INIT_CONFIG_PRESENT]);
    expect(result.refusals[0]?.detail).toBe(MOE_CONFIG_FILENAME);
  });

  it("reports every applicable refusal in a fixed order", () => {
    expect(refusedCodes({ probe: { entries: [MOE_CONFIG_FILENAME], writable: false } }))
      .toEqual([MOE_INIT_TARGET_UNWRITABLE, MOE_INIT_CONFIG_PRESENT, MOE_INIT_TARGET_NOT_EMPTY]);
  });
});

describe("parseMoeConfig reads back what planInit wrote", () => {
  function bytes(): string {
    const file = planned().files[0];
    if (file === undefined) throw new Error("unreachable: the config file is always planned");
    return file.contents;
  }

  it("round-trips the planned bytes into the launch identities", () => {
    const parsed = parseMoeConfig(bytes());
    if (!parsed.ok) throw new Error(`expected a config, got ${parsed.code}`);
    expect(parsed.config).toEqual({
      credential: fixedHex(32),
      projectId: TARGET_PROJECT_ID,
      schemaVersion: "moe-cli-config/1",
      storePath: planned().storePath,
    });
  });

  it("refuses bytes that are not JSON", () => {
    const parsed = parseMoeConfig("{not json");
    if (parsed.ok) throw new Error("expected a refusal, got a config");
    expect(parsed.code).toBe(MOE_CONFIG_UNREADABLE);
  });

  it("refuses a config missing a required field and names it", () => {
    const parsed = parseMoeConfig(JSON.stringify({
      credential: "ab", projectId: "demo", schemaVersion: "moe-cli-config/1",
    }));
    if (parsed.ok) throw new Error("expected a refusal, got a config");
    expect(parsed.code).toBe(MOE_CONFIG_INVALID);
    expect(parsed.detail).toBe("storePath");
  });

  it("refuses an empty required field rather than opening an empty store", () => {
    const parsed = parseMoeConfig(JSON.stringify({
      credential: "ab", projectId: "demo", schemaVersion: "moe-cli-config/1", storePath: "",
    }));
    if (parsed.ok) throw new Error("expected a refusal, got a config");
    expect(parsed.detail).toBe("storePath");
  });

  it("refuses a schema version this CLI does not own", () => {
    const parsed = parseMoeConfig(JSON.stringify({
      credential: "ab", projectId: "demo", schemaVersion: "moe-cli-config/2", storePath: "s",
    }));
    if (parsed.ok) throw new Error("expected a refusal, got a config");
    expect(parsed.code).toBe(MOE_CONFIG_INVALID);
    expect(parsed.detail).toBe("schemaVersion");
  });
});

describe("checkNodeVersion is the packed artifact's engines enforcement", () => {
  it("admits the documented prerequisite", () => {
    expect(checkNodeVersion("v24.16.0")).toBe(null);
  });

  it("admits a later 24.x patch and minor", () => {
    expect(checkNodeVersion("v24.20.3")).toBe(null);
  });

  it("refuses a Node 22 by name rather than dying on a syntax error", () => {
    expect(checkNodeVersion("v22.14.0")?.code).toBe(MOE_CLI_NODE_UNSUPPORTED);
    expect(checkNodeVersion("v22.14.0")?.detail).toBe("v22.14.0");
  });

  it("refuses the last unsupported 24.x minor", () => {
    expect(checkNodeVersion("v24.15.9")?.code).toBe(MOE_CLI_NODE_UNSUPPORTED);
  });

  it("refuses Node 25, the open end of the supported range", () => {
    expect(checkNodeVersion("v25.0.0")?.code).toBe(MOE_CLI_NODE_UNSUPPORTED);
  });

  it("refuses a version string it cannot parse", () => {
    expect(checkNodeVersion("banana")?.code).toBe(MOE_CLI_NODE_UNSUPPORTED);
  });
});
