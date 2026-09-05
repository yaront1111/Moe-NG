#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findJetbrainsProxy } from "./mcp-host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [findJetbrainsProxy()], {
  env: { ...process.env, MOE_PROJECT_PATH: root },
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
