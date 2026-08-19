import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MOE_CLI_LINK_MANIFEST_INVALID,
  MOE_CLI_LINK_TARGET_MISSING,
  WORKSPACE_LINK_SCHEMA_VERSION,
  ensureWorkspaceLinks,
  planWorkspaceLinks,
} from "./moe-cli-links.js";
import type { WorkspaceLinkResolution } from "./moe-cli-links.js";

const ROOT = "D:/extracted";

function manifest(links: Readonly<Record<string, string>>): string {
  return JSON.stringify({ links, schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION });
}

function planned(raw: string | null): Extract<WorkspaceLinkResolution, { ok: true }> {
  const result = planWorkspaceLinks(ROOT, raw);
  if (!result.ok) throw new Error(`expected a plan, got ${result.code}`);
  return result;
}

function refused(raw: string | null): Extract<WorkspaceLinkResolution, { ok: false }> {
  const result = planWorkspaceLinks(ROOT, raw);
  if (result.ok) throw new Error("expected a refusal, got a plan");
  return result;
}

const scratch: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "moe-links-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { force: true, recursive: true });
});

describe("planWorkspaceLinks", () => {
  it("plans nothing when the manifest is absent, which is the repo checkout", () => {
    expect(planned(null).entries).toEqual([]);
  });

  it("resolves each specifier to a link under node_modules and a target outside it", () => {
    const plan = planned(manifest({ "@moe/contracts": "packages/contracts" }));
    expect(plan.entries).toHaveLength(1);
    const entry = plan.entries[0];
    if (entry === undefined) throw new Error("unreachable: one entry was planned");
    expect(entry.specifier).toBe("@moe/contracts");
    expect(entry.linkPath.replaceAll("\\", "/")).toBe(`${ROOT}/node_modules/@moe/contracts`);
    expect(entry.targetPath.replaceAll("\\", "/")).toBe(`${ROOT}/packages/contracts`);
  });

  it("orders entries by specifier so two runs plan the same bytes", () => {
    const plan = planned(manifest({
      "@moe/store": "packages/store", "@moe/contracts": "packages/contracts",
    }));
    expect(plan.entries.map((entry) => entry.specifier)).toEqual([
      "@moe/contracts", "@moe/store",
    ]);
  });

  it("refuses bytes that are not JSON", () => {
    expect(refused("{nope").code).toBe(MOE_CLI_LINK_MANIFEST_INVALID);
  });

  it("refuses a schema version it does not own", () => {
    const raw = JSON.stringify({ links: {}, schemaVersion: "moe-workspace-links/2" });
    expect(refused(raw).detail).toBe("schemaVersion");
  });

  it("refuses a target that escapes the extracted root", () => {
    expect(refused(manifest({ "@moe/contracts": "../elsewhere" })).detail).toBe("../elsewhere");
  });

  it("refuses an absolute target, which would not survive being moved", () => {
    expect(refused(manifest({ "@moe/contracts": "D:/packages/contracts" })).detail)
      .toBe("D:/packages/contracts");
  });

  /**
   * The whole reason these links exist: Node 24 answers
   * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING for a .ts file whose REALPATH is
   * under node_modules. A target inside node_modules links the packages straight
   * back into the ban.
   */
  it("refuses a target inside node_modules, which reinstates the type-stripping ban", () => {
    expect(refused(manifest({ "@moe/contracts": "node_modules/.store/contracts" })).detail)
      .toBe("node_modules/.store/contracts");
  });

  /**
   * Windows resolves `Node_Modules` and `node_modules` to the SAME directory, so
   * a case-sensitive segment check is a bypass of the rule above, not a rule.
   */
  it("refuses a node_modules target whose case differs, which Windows resolves alike", () => {
    expect(refused(manifest({ "@moe/contracts": "Node_Modules/.store/contracts" })).detail)
      .toBe("Node_Modules/.store/contracts");
  });

  it("refuses an escaping target whose separator is a backslash", () => {
    expect(refused(manifest({ "@moe/contracts": "packages\\..\\..\\elsewhere" })).detail)
      .toBe("packages\\..\\..\\elsewhere");
  });

  it("refuses a specifier outside the @moe scope", () => {
    expect(refused(manifest({ express: "packages/express" })).detail).toBe("express");
  });
});

describe("ensureWorkspaceLinks materializes what the zip could not carry", () => {
  it("creates the link and makes the target reachable through node_modules", () => {
    const root = temp();
    mkdirSync(join(root, "packages", "contracts"), { recursive: true });
    writeFileSync(join(root, "packages", "contracts", "marker.txt"), "hello");
    const result = ensureWorkspaceLinks(root, manifest({ "@moe/contracts": "packages/contracts" }));
    if (!result.ok) throw new Error(`expected links, got ${result.code}`);
    expect(result.created).toEqual(["@moe/contracts"]);
    expect(
      // Read THROUGH the link, not beside it: an existing directory would pass a
      // mere existence check while resolving nothing.
      readFileSync(join(root, "node_modules", "@moe", "contracts", "marker.txt"), "utf8"),
    ).toBe("hello");
  });

  it("is idempotent: a second run creates nothing and still refuses nothing", () => {
    const root = temp();
    mkdirSync(join(root, "packages", "contracts"), { recursive: true });
    const raw = manifest({ "@moe/contracts": "packages/contracts" });
    ensureWorkspaceLinks(root, raw);
    const second = ensureWorkspaceLinks(root, raw);
    if (!second.ok) throw new Error(`expected links, got ${second.code}`);
    expect(second.created).toEqual([]);
  });

  it("heals a link left dangling by a move rather than failing on EEXIST", () => {
    const root = temp();
    mkdirSync(join(root, "packages", "contracts"), { recursive: true });
    writeFileSync(join(root, "packages", "contracts", "marker.txt"), "healed");
    mkdirSync(join(root, "node_modules", "@moe"), { recursive: true });
    symlinkSync(join(root, "gone"), join(root, "node_modules", "@moe", "contracts"), "junction");
    const result = ensureWorkspaceLinks(root, manifest({ "@moe/contracts": "packages/contracts" }));
    if (!result.ok) throw new Error(`expected links, got ${result.code}`);
    expect(result.created).toEqual(["@moe/contracts"]);
    expect(readFileSync(
      join(root, "node_modules", "@moe", "contracts", "marker.txt"), "utf8",
    )).toBe("healed");
  });

  it("refuses by name when the target the manifest promises is absent", () => {
    const root = temp();
    const result = ensureWorkspaceLinks(root, manifest({ "@moe/contracts": "packages/contracts" }));
    if (result.ok) throw new Error("expected a refusal, got links");
    expect(result.code).toBe(MOE_CLI_LINK_TARGET_MISSING);
    expect(result.detail).toBe("@moe/contracts");
  });
});

