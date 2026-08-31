import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBrokerBinary } from "./windows-broker-path.js";
import type { WindowsProcessUnknown } from "./windows-process-contract.js";

const CHECKOUT_BROKER = join(
  "dist", "windows-job-native", "release", "moe-windows-job-broker.exe",
);
const PACKAGE_BROKER = join("packages", "runner", "bin", "moe-windows-job-broker.exe");

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-broker-path-"));
  roots.push(root);
  return root;
}

function regularFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "broker-bytes");
}

function unknown(value: string | WindowsProcessUnknown): WindowsProcessUnknown {
  if (typeof value === "string") throw new Error(`expected UNKNOWN, got ${value}`);
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resolveBrokerBinary across checkout and extracted layouts", () => {
  it("resolves the checkout build only from a workspace-marked root", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const broker = join(root, CHECKOUT_BROKER);
    regularFile(broker);

    expect(resolveBrokerBinary(root)).toBe(broker);
  });

  it("resolves an extracted package without a workspace marker", () => {
    const root = temporaryRoot();
    const broker = join(root, PACKAGE_BROKER);
    regularFile(broker);
    const extractedModule = join(
      root, "packages", "runner", "src", "platform", "windows", "windows-broker-path.ts",
    );
    expect(resolveBrokerBinary(undefined, extractedModule)).toBe(broker);
  });

  it("does not adopt a broker from an unrelated ancestor workspace", () => {
    const outer = temporaryRoot();
    writeFileSync(join(outer, "pnpm-workspace.yaml"), "packages: []\n");
    regularFile(join(outer, CHECKOUT_BROKER));
    const artifact = join(outer, "downloads", "moe-windows");
    const broker = join(artifact, PACKAGE_BROKER);
    regularFile(broker);
    const extractedModule = join(
      artifact,
      "packages", "runner", "src", "platform", "windows", "windows-broker-path.ts",
    );

    expect(resolveBrokerBinary(undefined, extractedModule)).toBe(broker);
  });

  it("refuses a non-file shipped broker without falling back to checkout output", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, PACKAGE_BROKER), { recursive: true });
    regularFile(join(root, CHECKOUT_BROKER));
    const extractedModule = join(
      root, "packages", "runner", "src", "platform", "windows", "windows-broker-path.ts",
    );
    expect(unknown(resolveBrokerBinary(undefined, extractedModule))).toMatchObject({
      code: "PROCESS_BOUNDARY_BROKER_UNRESOLVED",
      identity: null,
      layer: "WINDOWS_PROCESS_RESOLUTION",
      message: "the shipped broker is missing or is not a regular file",
    });
  });
});
