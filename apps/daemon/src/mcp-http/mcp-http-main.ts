#!/usr/bin/env node

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "../daemon-store-dependencies.js";
import {
  MCP_HTTP_HOST_ENV,
  createMcpHttpHost,
  readHttpPort,
} from "./mcp-http-host.js";

/**
 * The Streamable HTTP sibling of `mcp-main.ts`: the same durable pipeline, reached over the
 * official MCP HTTP transport instead of stdio. One process serves many agent sessions here,
 * where the stdio entry serves exactly one — that is the only behavioural difference, and it
 * comes from the transport, not from a second authority.
 *
 * Environment (all refusals name the VARIABLE, never a value):
 * - MOE_STORE_PATH / MOE_PROJECT_ID / MOE_DAEMON_CREDENTIAL — store wiring, same as the daemon
 *   bin and the stdio entry.
 * - MOE_MCP_HTTP_PORT — optional; defaults to an ephemeral port. A value that is not a
 *   non-negative integer is refused BY NAME rather than silently coerced to 0, because a typo
 *   that quietly binds a random port is worse than a startup failure.
 * - MOE_MCP_HTTP_HOST — optional; defaults to 127.0.0.1. The host itself refuses a
 *   non-loopback bind, so this cannot widen exposure by configuration.
 *
 * Reads go through the provider's own subscription seam, exactly as the stdio entry does.
 */

async function main(): Promise<void> {
  const config = readStoreDependencyEnv(process.env);
  const provider = createStoreDependencies(config);
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");

  const host = createMcpHttpHost({
    affordances: provider.affordances?.(),
    // Same shape as the stdio entry: both planes plus the per-dispatch plane reader.
    commandAuthorityPlane: provider.commandAuthorityPlane?.(),
    deps: provider.provide(),
    documents: provider.goalSource?.(),
    graph: provider.graph?.(),
    port: readHttpPort(process.env),
    subscriptions,
    v2Deps: provider.provideV2?.(),
    ...(process.env[MCP_HTTP_HOST_ENV] === undefined
      ? {}
      : { host: process.env[MCP_HTTP_HOST_ENV] }),
  });

  const started = await host.start();
  if (!started.ok) throw new Error(started.code);
  // The bound origin is the one operational fact a supervisor needs, and it contains no
  // credential and no store path.
  process.stdout.write(`${started.origin}\n`);
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "startup failed"}\n`);
    process.exitCode = 1;
  });
}

export { main as runMcpHttpMain };
