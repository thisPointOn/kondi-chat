import type { MCPTool } from '../types/mcp';
import { LOCAL_SERVER_ID } from '../services/localTools';

/** Server IDs for built-in/local services that are always available regardless of restrictions. */
export const BUILTIN_SERVER_IDS = [LOCAL_SERVER_ID, 'kondi-search'];

/**
 * Filter MCP tools map based on allowed server IDs.
 *   undefined  → all servers (unrestricted)
 *   []         → no servers at all (fully restricted)
 *   ['a','b']  → built-in servers + listed servers
 */
export function filterToolsByServerIds(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  allowedServerIds?: string[]
): Map<string, { serverId: string; tools: MCPTool[] }> {
  if (allowedServerIds === undefined) return tools;
  const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
  const includeBuiltins = allowedServerIds.length > 0;
  for (const [key, value] of tools) {
    if ((includeBuiltins && BUILTIN_SERVER_IDS.includes(key)) || allowedServerIds.includes(key)) {
      filtered.set(key, value);
    }
  }
  return filtered;
}

/** Count total tools across all servers */
export function countTools(tools: Map<string, { serverId: string; tools: MCPTool[] }>): number {
  let count = 0;
  for (const [, v] of tools) count += v.tools.length;
  return count;
}

/**
 * Pre-flight check: scan prompt text for MCP tool references and warn if
 * any referenced tools aren't available. Prevents wasting a full council
 * run only to fail mid-way because a tool server isn't connected.
 *
 * Looks for patterns like `mcp__serverId__toolName` in the prompt text
 * and verifies the server is in the available tools map.
 */
export function verifyRequiredTools(
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
  promptText: string,
  contextLabel: string
): void {
  // Match mcp__<server>__<tool> patterns commonly used in prompts
  const mcpPattern = /mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_-]+)/g;
  const referencedServers = new Set<string>();
  let match;
  while ((match = mcpPattern.exec(promptText)) !== null) {
    referencedServers.add(match[1]);
  }

  if (referencedServers.size === 0) return;

  const availableServerIds = new Set<string>();
  for (const [key] of availableTools) {
    availableServerIds.add(key);
  }

  const missing = [...referencedServers].filter(
    (s) => !availableServerIds.has(s) && !BUILTIN_SERVER_IDS.includes(s)
  );

  if (missing.length > 0) {
    console.warn(
      `[verifyRequiredTools] "${contextLabel}" references MCP servers not currently connected: ${missing.join(', ')}. ` +
      `Tools from these servers will not be available during execution.`
    );
  }
}
