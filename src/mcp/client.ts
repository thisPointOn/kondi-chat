/**
 * MCP Client Manager — connects to MCP servers and exposes their tools.
 *
 * Supports:
 *   - stdio: local process (command + args)
 *   - http/sse: remote server (URL + optional headers)
 *
 * Each server's tools are namespaced as "servername__toolname" to avoid
 * collisions across servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  McpScopedConfig, McpServerState, McpToolInfo, McpConnectionStatus,
} from './types.ts';

// ---------------------------------------------------------------------------
// MCP Client Manager
// ---------------------------------------------------------------------------

export class McpClientManager {
  private servers: Map<string, McpServerState> = new Map();
  private clients: Map<string, { client: Client; cleanup: () => Promise<void> }> = new Map();

  /** Connect to all configured servers */
  async connectAll(configs: Map<string, McpScopedConfig>): Promise<void> {
    const promises = [...configs.entries()].map(([name, config]) =>
      this.connect(name, config)
    );
    await Promise.allSettled(promises);
  }

  /** Connect to a single server */
  async connect(name: string, config: McpScopedConfig): Promise<McpServerState> {
    // Clean up existing connection if any
    await this.disconnect(name);

    const state: McpServerState = {
      name,
      status: 'pending',
      config,
      tools: [],
    };
    this.servers.set(name, state);

    const configType = 'type' in config ? config.type : 'stdio';
    process.stderr.write(`[mcp] Connecting to ${name} (${configType || 'stdio'})...\n`);

    try {
      const { client, cleanup } = await this.createClient(name, config);
      this.clients.set(name, { client, cleanup });

      // Discover tools
      const toolsResult = await client.listTools();
      const tools: McpToolInfo[] = (toolsResult.tools || []).map(tool => ({
        qualifiedName: `${name}__${tool.name}`,
        originalName: tool.name,
        serverName: name,
        description: tool.description || '',
        parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      }));

      state.status = 'connected';
      state.tools = tools;

      process.stderr.write(`[mcp] ${name}: connected (${tools.length} tools)\n`);
    } catch (error) {
      state.status = 'failed';
      state.error = (error as Error).message;
      process.stderr.write(`[mcp] ${name}: failed — ${state.error}\n`);
    }

    return state;
  }

  /** Disconnect a server */
  async disconnect(name: string): Promise<void> {
    const entry = this.clients.get(name);
    if (entry) {
      try {
        await entry.cleanup();
      } catch { /* ignore cleanup errors */ }
      this.clients.delete(name);
    }
    this.servers.delete(name);
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    const names = [...this.servers.keys()];
    await Promise.allSettled(names.map(n => this.disconnect(n)));
  }

  // -------------------------------------------------------------------------
  // Tool access
  // -------------------------------------------------------------------------

  /** Get all tools from all connected servers */
  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const state of this.servers.values()) {
      if (state.status === 'connected') {
        tools.push(...state.tools);
      }
    }
    return tools;
  }

  /** Call a tool on an MCP server */
  async callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }> {
    // Parse server__tool
    const sep = qualifiedName.indexOf('__');
    if (sep < 0) {
      return { content: `Invalid MCP tool name: ${qualifiedName}`, isError: true };
    }

    const serverName = qualifiedName.slice(0, sep);
    const toolName = qualifiedName.slice(sep + 2);

    const entry = this.clients.get(serverName);
    if (!entry) {
      return { content: `MCP server not connected: ${serverName}`, isError: true };
    }

    try {
      const result = await entry.client.callTool({ name: toolName, arguments: args });

      // Extract text content from MCP response
      const textParts = (result.content as any[])
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text) || [];

      return {
        content: textParts.join('\n') || '(no output)',
        isError: result.isError === true,
      };
    } catch (error) {
      return { content: `MCP tool error: ${(error as Error).message}`, isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // Server state
  // -------------------------------------------------------------------------

  getServers(): McpServerState[] {
    return [...this.servers.values()];
  }

  getServer(name: string): McpServerState | undefined {
    return this.servers.get(name);
  }

  /** Format for display */
  format(): string {
    const servers = this.getServers();
    if (servers.length === 0) return 'No MCP servers configured. See /mcp add.';

    const lines: string[] = ['MCP Servers:'];
    for (const s of servers) {
      const icon = s.status === 'connected' ? 'OK' : s.status === 'failed' ? 'FAIL' : '...';
      const scope = s.config.scope;
      const type = s.config.type || 'stdio';
      lines.push(`  [${icon.padEnd(4)}] ${s.name} (${type}, ${scope})`);
      if (s.status === 'connected') {
        lines.push(`         ${s.tools.length} tools: ${s.tools.map(t => t.originalName).join(', ')}`);
      }
      if (s.error) {
        lines.push(`         Error: ${s.error}`);
      }
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Transport creation
  // -------------------------------------------------------------------------

  private async createClient(
    name: string,
    config: McpScopedConfig,
  ): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const client = new Client({ name: `kondi-chat-${name}`, version: '0.1.0' });
    const type = 'type' in config ? config.type || 'stdio' : 'stdio';

    if (type === 'stdio') {
      const stdioConfig = config as { command: string; args?: string[]; env?: Record<string, string>; scope: string };
      const transport = new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args || [],
        env: { ...process.env, ...(stdioConfig.env || {}) } as Record<string, string>,
      });

      await client.connect(transport);
      return {
        client,
        cleanup: async () => {
          await client.close();
        },
      };
    }

    if (type === 'http' || type === 'sse') {
      const httpConfig = config as { url: string; headers?: Record<string, string>; scope: string };
      const transport = new StreamableHTTPClientTransport(
        new URL(httpConfig.url),
      );

      await client.connect(transport);
      return {
        client,
        cleanup: async () => {
          await client.close();
        },
      };
    }

    throw new Error(`Unsupported MCP transport: ${type}`);
  }
}
