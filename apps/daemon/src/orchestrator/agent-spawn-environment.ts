/**
 * What one agent process is allowed to see: its tool surface, its environment,
 * and the one MCP origin it may talk to.
 *
 * Split out of `agent-spawner.ts` so the process lifecycle and the rules about
 * what an agent inherits stay separately readable, and so the spawner stays
 * under the per-file line rail while it grows a start-admission surface. Nothing
 * here spawns, writes, or observes: every function is pure over its arguments.
 */
import { deliverEnvironment, type EnvironmentDeliveredVariables } from "../environment/environment-delivery.js";

export { CHAIN_TOOLS, CODING_BUILTIN_TOOLS, CODING_TOOLS } from "./agent-role-contract.js";

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

const DEFAULT_MCP_OUTPUT_TOKENS = "120000";

/**
 * `delivered` is applied LAST, to the object this function has finished building - never folded
 * into `source`, where the closed roster above would drop every arbitrary operator name and the
 * only way to make one arrive would be to widen the roster. It is optional and defaults to
 * nothing, so every existing caller keeps producing a byte-identical environment.
 */
export function agentEnvironment(
  source: NodeJS.ProcessEnv, delivered?: EnvironmentDeliveredVariables,
): NodeJS.ProcessEnv {
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
  // The size of one MCP tool result the seat may read in context. Claude's default
  // (25000 tokens) spills a PRD-sized answer to disk, where an MCP-only planning seat
  // cannot follow it (measured 2026-09-03 on UnAI's ~121 KB PRD). The operator's own
  // setting wins when present.
  environment["MAX_MCP_OUTPUT_TOKENS"] = source["MAX_MCP_OUTPUT_TOKENS"] ?? DEFAULT_MCP_OUTPUT_TOKENS;
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
  return deliverEnvironment(environment, delivered).environment;
}
