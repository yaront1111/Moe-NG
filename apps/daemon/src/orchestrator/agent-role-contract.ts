import { codexMcpRosterArgs } from "./agent-codex-roster.js";

/** Role instructions and process tool selection share this contract. */
export const CHAIN_TOOLS = "mcp__moe-next,mcp__moe-next__*";
export const CODING_BUILTIN_TOOLS = "Edit,Write,Read,Glob,Grep,Bash";
export const CODING_TOOLS = `${CHAIN_TOOLS},${CODING_BUILTIN_TOOLS}`;

interface AgentRoleContract {
  readonly allowedTools: string;
  readonly builtinTools: string;
  /**
   * The SAME grant as `allowedTools`, spelled the one way codex accepts it (see
   * agent-codex-roster.ts). DERIVED here rather than declared, so a tool added or removed above
   * moves both providers at once instead of leaving the parity test to hold them together. The
   * BUILTIN half is deliberately absent: codex has no roster for its own file and shell access,
   * which `sandbox` below governs from this same seat kind — do not add a phantom override.
   */
  readonly codexRosterArgs: readonly string[];
  readonly fileInstructions: string;
  readonly sandbox: "read-only" | "workspace-write";
}

const CHAIN_ROLE: AgentRoleContract = Object.freeze({
  allowedTools: CHAIN_TOOLS,
  builtinTools: "",
  codexRosterArgs: codexMcpRosterArgs(CHAIN_TOOLS),
  fileInstructions: "You have no file-write tool in this session: report findings in your "
    + "final message, do not try to write memories or files.",
  sandbox: "read-only",
});

const CODING_ROLE: AgentRoleContract = Object.freeze({
  allowedTools: CODING_TOOLS,
  builtinTools: CODING_BUILTIN_TOOLS,
  codexRosterArgs: codexMcpRosterArgs(CODING_TOOLS),
  fileInstructions: "You may edit files in your assigned workspace and run its tests. "
    + "Preserve unrelated changes; report findings in your final message, do not try to write memories.",
  sandbox: "workspace-write",
});

export function agentRoleForWorkspace(workspace: string | null): AgentRoleContract {
  return workspace === null ? CHAIN_ROLE : CODING_ROLE;
}
