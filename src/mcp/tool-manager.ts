/**
 * Tool Manager — merges built-in tools and MCP tools into a unified set.
 *
 * Handles:
 * - Combining built-in tools (read_file, etc.) with MCP tools
 * - Dispatching tool calls to the right handler (built-in or MCP)
 * - Filtering tools per request to save tokens
 * - Converting MCP tools to our ToolDefinition format
 */

import type { ToolDefinition } from '../types.ts';
import { AGENT_TOOLS, executeTool, type ToolContext } from '../engine/tools.ts';
import { McpClientManager } from './client.ts';
import type { McpToolInfo } from './types.ts';

// ---------------------------------------------------------------------------
// Tool categories for filtering
// ---------------------------------------------------------------------------

/** Built-in tool categories */
const BUILTIN_CATEGORIES: Record<string, string[]> = {
  read_file: ['filesystem', 'coding'],
  write_file: ['filesystem', 'coding'],
  edit_file: ['filesystem', 'coding'],
  list_files: ['filesystem', 'coding'],
  search_code: ['coding', 'analysis'],
  run_command: ['system', 'coding'],
  create_task: ['coding', 'execution'],
  update_plan: ['planning'],
};

/** Phase → which tool categories are relevant */
const PHASE_TOOLS: Record<string, string[]> = {
  discuss: ['filesystem', 'coding', 'analysis', 'planning', 'system'],
  dispatch: ['planning'],
  execute: ['filesystem', 'coding', 'system'],
  reflect: [],
  compress: [],
  state_update: ['planning'],
};

// ---------------------------------------------------------------------------
// Tool Manager
// ---------------------------------------------------------------------------

export class ToolManager {
  private mcpClient: McpClientManager;

  constructor(mcpClient: McpClientManager) {
    this.mcpClient = mcpClient;
  }

  /**
   * Get all available tool definitions (built-in + MCP).
   * Optionally filter by phase for token efficiency.
   */
  getTools(phase?: string): ToolDefinition[] {
    const builtIn = AGENT_TOOLS;
    const mcpTools = this.mcpClient.getAllTools().map(mcpToToolDef);
    const all = [...builtIn, ...mcpTools];

    if (!phase) return all;

    // Filter by phase relevance
    const relevantCategories = PHASE_TOOLS[phase];
    if (!relevantCategories) return all;

    return all.filter(tool => {
      // Built-in tools: check category
      const categories = BUILTIN_CATEGORIES[tool.name];
      if (categories) {
        return categories.some(c => relevantCategories.includes(c));
      }
      // MCP tools: always include for now (can't categorize without metadata)
      // TODO: use tool description to auto-categorize
      return true;
    });
  }

  /**
   * Execute a tool call — routes to built-in handler or MCP server.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    toolCtx: ToolContext,
  ): Promise<{ content: string; isError?: boolean }> {
    // Check if it's an MCP tool (contains __ separator)
    if (name.includes('__')) {
      return this.mcpClient.callTool(name, args);
    }

    // Built-in tool
    return executeTool(name, args, toolCtx);
  }

  /** Get summary for display */
  getSummary(): { builtIn: number; mcp: number; servers: number } {
    return {
      builtIn: AGENT_TOOLS.length,
      mcp: this.mcpClient.getAllTools().length,
      servers: this.mcpClient.getServers().filter(s => s.status === 'connected').length,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpToToolDef(tool: McpToolInfo): ToolDefinition {
  return {
    name: tool.qualifiedName,
    description: `[${tool.serverName}] ${tool.description}`,
    parameters: tool.parameters,
  };
}
