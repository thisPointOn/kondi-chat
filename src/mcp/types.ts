/**
 * MCP types — configuration and connection state.
 *
 * Compatible with Claude Code's settings.json format for mcpServers.
 */

// ---------------------------------------------------------------------------
// Server configuration (matches Claude Code format)
// ---------------------------------------------------------------------------

export interface McpStdioConfig {
  type?: 'stdio';  // Optional for backward compat (default is stdio)
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** Scope: where was this config loaded from? */
export type McpScope = 'local' | 'user' | 'project';

export type McpScopedConfig = McpServerConfig & { scope: McpScope };

/** The full config file format */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  /** Fully qualified name: servername__toolname */
  qualifiedName: string;
  /** Original tool name from the MCP server */
  originalName: string;
  /** Which server provides this tool */
  serverName: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Tool categories for filtering (derived from server name or tool metadata) */
  categories?: string[];
}

export type McpConnectionStatus = 'connected' | 'failed' | 'pending' | 'disconnected';

export interface McpServerState {
  name: string;
  status: McpConnectionStatus;
  config: McpScopedConfig;
  tools: McpToolInfo[];
  error?: string;
}
