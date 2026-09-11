import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it, vi } from "vitest";

import { admitCargoPackTool, readCargoToolchainPins, type CargoSpawn } from "./pack-cargo-tool.js";
import { WINDOWS_PACK_REPOSITORY_ROOT } from "./pack-windows-main.js";

it("passes the CLI's directory-derived repository root through Cargo admission", () => {
  // macOS may expose TEMP through /var while the admitted tool lives under /private/var.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "moe-pack-cli-root-")));
  try {
    const trackedPin = readCargoToolchainPins();
    const executable = join(scratch, "toolchains", trackedPin.toolchain, "bin", "cargo.exe");
    const bytes = Buffer.from("isolated Cargo identity fixture; never executed");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, bytes);
    const spawn = vi.fn<CargoSpawn>(() => ({
      status: 0, stderr: "", stdout: `${trackedPin.cargoVersionLine}\n`,
    }));

    const admitted = admitCargoPackTool(WINDOWS_PACK_REPOSITORY_ROOT, executable, {
      ...trackedPin, cargoSha256: createHash("sha256").update(bytes).digest("hex"),
    }, { architecture: "x64", platform: "win32", spawn });

    expect(admitted.kind).toBe("cargo");
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[1]).toEqual(["--version"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
