import { existsSync } from "node:fs";
import { join } from "node:path";
import { killTree, spawnNode } from "./daemon-children.js";
import { repoRoot, serverEnv } from "./daemon-ports.js";
import type { StaticHarnessPorts } from "./harness.js";
import { createStaticControlRoomPorts } from "./static-ports.js";

/** Build the real app with development fixtures admitted; production still strips them. */
export function productWorkspacePorts(): StaticHarnessPorts {
  return { ...createStaticControlRoomPorts(), buildBundle: async () => {
    const root = repoRoot();
    if (root === null) return false;
    const app = join(root, "apps", "control-room");
    const build = spawnNode([join(app, "node_modules", "vite", "bin", "vite.js"), "build"], app,
      { ...serverEnv("http://127.0.0.1:1", "ABSENT"), NODE_ENV: "development" });
    try {
      const code = await new Promise<number | null>((done) => {
        const timer = setTimeout(() => done(null), 120_000);
        build.child.once("error", () => { clearTimeout(timer); done(null); });
        build.child.once("exit", (exitCode) => { clearTimeout(timer); done(exitCode); });
      });
      return code === 0 && existsSync(join(app, "dist", "index.html"));
    } finally { await killTree(build.child); }
  } };
}
