/**
 * What one agent process is allowed to see: its tool surface, its environment,
 * and the one MCP origin it may talk to.
 *
 * Split out of `agent-spawner.ts` so the process lifecycle and the rules about
 * what an agent inherits stay separately readable, and so the spawner stays
 * under the per-file line rail while it grows a start-admission surface. Nothing
 * here spawns, writes, or observes: every function is pure over its arguments.
 */
export const CHAIN_TOOLS = "mcp__moe-next,mcp__moe-next__*";
export const CODING_TOOLS = `${CHAIN_TOOLS},Edit,Write,Read,Glob,Grep,Bash`;
export const CODING_BUILTIN_TOOLS = "Edit,Write,Read,Glob,Grep,Bash";

const RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "ALL_PROXY", "APPDATA", "COLORTERM", "COMSPEC", "FORCE_COLOR", "HOMEDRIVE",
  "HOMEPATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS", "NO_COLOR", "PATH", "PATHEXT", "PROGRAMDATA", "SHELL",
  "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "WINDIR",
]);
/**
 * Sorted and CLOSED. `CODEX_` and `OPENAI_` carry the codex cli's auth surface,
 * measured 2026-08-20 against codex-cli 0.147.0: CODEX_HOME (the state dir
 * holding a ChatGPT subscription seat — `codex exec --help` says "auth still
 * uses `CODEX_HOME`"), CODEX_ACCESS_TOKEN, OPENAI_API_KEY, CODEX_API_KEY. No
 * `CHATGPT_` prefix is listed because the binary honors no such variable.
 */
const PROVIDER_ENVIRONMENT_PREFIXES = Object.freeze([
  "ANTHROPIC_", "AWS_", "AZURE_", "CLAUDE_", "CODEX_", "GOOGLE_", "OPENAI_",
  "VERTEX_",
] as const);
const LOOPBACK_NO_PROXY = Object.freeze(["127.0.0.1", "localhost", "::1"] as const);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function trustedMcpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MCP_HTTP_ORIGIN_INVALID");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.username !== "" || parsed.password !== "" || parsed.origin !== value) {
    throw new Error("MCP_HTTP_ORIGIN_INVALID");
  }
  return parsed.origin;
}

export function agentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith("MOE_") || value === undefined) continue;
    if (RUNTIME_ENVIRONMENT_KEYS.has(normalized)
      || PROVIDER_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      environment[key] = value;
    }
  }
  // Claude keeps provider credentials for its own API call but strips them
  // from Bash, hooks and subprocess MCP servers. Scripted sessions also leave
  // no resumable transcript containing mission or tool output.
  environment["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";
  environment["CLAUDE_CODE_SKIP_PROMPT_HISTORY"] = "1";
  // Claude honors standard proxy variables. Force its loopback MCP connection
  // around any enterprise proxy so the scoped bearer never leaves this host.
  const bypass = [source["NO_PROXY"], source["no_proxy"]]
    .flatMap((value) => value?.split(/[\s,]+/u) ?? [])
    .filter((value, index, values) => value !== "" && values.indexOf(value) === index);
  for (const host of LOOPBACK_NO_PROXY) {
    if (!bypass.includes(host)) bypass.push(host);
  }
  environment["NO_PROXY"] = bypass.join(",");
  environment["no_proxy"] = bypass.join(",");
  return environment;
}
