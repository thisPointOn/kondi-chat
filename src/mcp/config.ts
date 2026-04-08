/**
 * MCP Config — loads server configuration from multiple scopes.
 *
 * Config files (checked in order, merged):
 *   1. Project: .kondi-chat/mcp.json (project-specific)
 *   2. User: ~/.kondi-chat/mcp.json (user-wide)
 *
 * Format (same as Claude Code):
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
 *     },
 *     "remote-api": {
 *       "type": "http",
 *       "url": "https://api.example.com/mcp"
 *     }
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpConfigFile, McpServerConfig, McpScopedConfig, McpScope } from './types.ts';

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export function loadMcpConfig(projectDir: string): Map<string, McpScopedConfig> {
  const servers = new Map<string, McpScopedConfig>();

  // Load user-level config first (lower priority)
  const userDir = join(homedir(), '.kondi-chat');
  const userConfig = loadConfigFile(join(userDir, 'mcp.json'), 'user');
  for (const [name, config] of userConfig) {
    servers.set(name, config);
  }

  // Load project-level config (higher priority, overrides user)
  const projectConfig = loadConfigFile(join(projectDir, '.kondi-chat', 'mcp.json'), 'project');
  for (const [name, config] of projectConfig) {
    servers.set(name, config);
  }

  return servers;
}

function loadConfigFile(path: string, scope: McpScope): Map<string, McpScopedConfig> {
  const servers = new Map<string, McpScopedConfig>();
  if (!existsSync(path)) return servers;

  try {
    const raw = readFileSync(path, 'utf-8');
    const config: McpConfigFile = JSON.parse(raw);

    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        servers.set(name, { ...serverConfig, scope });
      }
    }
  } catch (error) {
    process.stderr.write(`[mcp] Failed to load ${path}: ${(error as Error).message}\n`);
  }

  return servers;
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

export function saveMcpServer(
  projectDir: string,
  name: string,
  config: McpServerConfig,
  scope: McpScope = 'project',
): void {
  const dir = scope === 'user'
    ? join(homedir(), '.kondi-chat')
    : join(projectDir, '.kondi-chat');
  const path = join(dir, 'mcp.json');

  mkdirSync(dir, { recursive: true });

  let existing: McpConfigFile = { mcpServers: {} };
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch { /* start fresh */ }
  }

  existing.mcpServers[name] = config;
  writeFileSync(path, JSON.stringify(existing, null, 2));
}

export function removeMcpServer(
  projectDir: string,
  name: string,
  scope: McpScope = 'project',
): boolean {
  const dir = scope === 'user'
    ? join(homedir(), '.kondi-chat')
    : join(projectDir, '.kondi-chat');
  const path = join(dir, 'mcp.json');

  if (!existsSync(path)) return false;

  try {
    const existing: McpConfigFile = JSON.parse(readFileSync(path, 'utf-8'));
    if (!existing.mcpServers[name]) return false;
    delete existing.mcpServers[name];
    writeFileSync(path, JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
}
