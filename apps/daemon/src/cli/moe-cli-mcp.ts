import { resolve } from "node:path";

import type { CliMcp } from "./moe-cli-argv.js";
// TYPE-ONLY from the entry module, and that is load-bearing: a VALUE import of
// `./moe-cli-main.js` is a second module record of the entry whose
// `isMainModule` is still true, so it re-runs the entry's top-level `await` and
// the process deadlocks. `import type` is erased and creates no such edge.
import type { CliIo } from "./moe-cli-main.js";
import { preparePackagedLinks, readConfig } from "./moe-cli-project.js";

/**
 * `moe mcp`: serves ONE already-initialized project to a headless MCP client
 * over stdio — no browser, no pairing, no CSRF token. The browser command route
 * is walled by Host + Origin + CSRF, and that token is minted at pairing, so a
 * free session (an agent, a CLI, a script) can never mint one. The MCP transport
 * authenticates by credential instead, which is exactly the door such a session
 * can walk through.
 *
 * Why a CLI verb and not a documented `.mcp.json` pointing straight at
 * `mcp-main.ts`: the `node_modules\@moe\*` junctions are created at COMMAND
 * time by `ensureWorkspaceLinks`, so in a freshly extracted artifact a direct
 * `node apps/daemon/src/mcp-main.ts` cannot resolve `@moe/mcp`. Only a path
 * that goes through the CLI has done the linking. It also keeps the operator
 * credential inside the project directory instead of copied into an agent's
 * config file.
 */

/** The stdio server could not be composed at all; the project was not served. */
export const MOE_CLI_MCP_UNAVAILABLE = "MOE_CLI_MCP_UNAVAILABLE" as const;

export async function runMcp(invocation: CliMcp, io: CliIo): Promise<number> {
  const projectRoot = resolve(io.cwd, invocation.targetDir);
  // STDOUT IS THE JSON-RPC WIRE on this verb. `readConfig` and
  // `preparePackagedLinks` are shared with `moe start`, where `log` is stdout,
  // so they are handed an `io` whose `log` IS the diagnostic sink. Redirecting
  // the sink rather than the call sites means a line added to either helper
  // later cannot leak onto the wire behind this verb's back.
  const offWire: CliIo = { ...io, log: io.diagnostic };
  const config = readConfig(projectRoot, offWire);
  if (config === null) return 1;
  if (!preparePackagedLinks(offWire, "mcp")) return 1;

  // `mcp-main.ts` reads its whole contract from the environment: the store trio
  // plus the caller's own credential. Both credential variables take the
  // operator secret, so this session dispatches with operator authority — which
  // is precisely why operator-only kinds are held off the advertised roster,
  // unless the owner passed `--as-operator` and so delegated them by name.
  // A relative storePath resolves against the project root, never the cwd.
  process.env["MOE_STORE_PATH"] = resolve(projectRoot, config.storePath);
  process.env["MOE_PROJECT_ID"] = config.projectId;
  process.env["MOE_DAEMON_CREDENTIAL"] = config.credential;
  process.env["MOE_SESSION_CREDENTIAL"] = config.credential;

  // Provenance names the project and the path; the credential's VALUE appears
  // in no line this verb ever writes.
  io.diagnostic(`moe mcp: project ${config.projectId} -> ${projectRoot}`);
  io.diagnostic("moe mcp: serving stdio JSON-RPC on stdout; diagnostics on stderr; no browser, no pairing");
  if (invocation.asOperator === true) {
    io.diagnostic("moe mcp: --as-operator: this session may decide approvals, escalations, clarifications and "
      + "goal closure AS THE OPERATOR; each attempt is logged MCP_OPERATOR_ACT_DELEGATED in this project's .moe/logs");
  }
  try {
    const { runMcpMain } = await import("../mcp-main.js");
    await runMcpMain({ asOperator: invocation.asOperator === true, projectRoot });
  } catch (error) {
    io.diagnostic(`${MOE_CLI_MCP_UNAVAILABLE}: ${error instanceof Error ? error.message : "startup failed"}`);
    return 1;
  }
  // The transport keeps the process alive from here; the stdio host owns the
  // drain and exits on stdin EOF, SIGINT or SIGTERM.
  return 0;
}
