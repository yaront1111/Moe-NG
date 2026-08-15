#!/usr/bin/env node
import {
  connectStdioTransport,
  createStdioMcpServer,
  readBootstrapCredential,
} from "@moe/mcp";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";

/**
 * The agent-facing entry: one MCP stdio server per agent session, exactly the
 * old-Moe shape — a wrapper starts `node src/mcp-main.ts` with the agent's
 * credential in MOE_SESSION_CREDENTIAL, and that agent's Claude session gets
 * one tool per runtime kind, every dispatch answered by the same durable
 * pipeline the HTTP listener serves.
 *
 * Environment (all refusals name the variable, never a value):
 * - MOE_STORE_PATH / MOE_PROJECT_ID / MOE_DAEMON_CREDENTIAL — store wiring,
 *   same as the daemon bin.
 * - MOE_SESSION_CREDENTIAL — THIS agent's credential: the operator secret, or
 *   a session credential minted via session.open with scoped capabilities.
 *
 * Reads go through the provider's own subscription seam, so an agent's
 * events_read folds and encodes exactly as the daemon's /events/read does.
 */
async function main(): Promise<void> {
  const credential = readBootstrapCredential();
  const config = readStoreDependencyEnv(process.env);
  const provider = createStoreDependencies(config);
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");

  const server = createStdioMcpServer({
    credential,
    port: createMcpDispatchPort({
      affordances: provider.affordances?.(),
      credential,
      deps: provider.provide(),
      subscriptions,
    }),
    serverName: "moe-next",
  });
  await connectStdioTransport(server);
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "startup failed"}\n`);
    process.exitCode = 1;
  });
}

export { main as runMcpMain };
