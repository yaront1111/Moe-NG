/** Role instructions and process tool selection share this contract. */
export const CHAIN_TOOLS = "mcp__moe-next,mcp__moe-next__*";
export const CODING_BUILTIN_TOOLS = "Edit,Write,Read,Glob,Grep,Bash";
export const CODING_TOOLS = `${CHAIN_TOOLS},${CODING_BUILTIN_TOOLS}`;

interface AgentRoleContract {
  readonly allowedTools: string;
  readonly builtinTools: string;
  readonly fileInstructions: string;
  readonly sandbox: "read-only" | "workspace-write";
}

const CHAIN_ROLE: AgentRoleContract = Object.freeze({
  allowedTools: CHAIN_TOOLS,
  builtinTools: "",
  fileInstructions: "You have no file-write tool in this session: report findings in your "
    + "final message, do not try to write memories or files.",
  sandbox: "read-only",
});

const CODING_ROLE: AgentRoleContract = Object.freeze({
  allowedTools: CODING_TOOLS,
  builtinTools: CODING_BUILTIN_TOOLS,
  fileInstructions: "You may edit files in your assigned workspace and run its tests. "
    + "Preserve unrelated changes; report findings in your final message, do not try to write memories.",
  sandbox: "workspace-write",
});

export function agentRoleForWorkspace(workspace: string | null): AgentRoleContract {
  return workspace === null ? CHAIN_ROLE : CODING_ROLE;
}
