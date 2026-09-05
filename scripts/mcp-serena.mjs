#!/usr/bin/env node
import { spawn } from "node:child_process";

import { findSerena } from "./mcp-host.mjs";

const context = process.argv[2] === "agent" ? "agent" : "claude-code";
const child = spawn(findSerena(), [
  "start-mcp-server",
  "--context", context,
  "--project", process.cwd(),
  "--enable-web-dashboard", "false",
  "--enable-gui-log-window", "false",
], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
