/**
 * Council Tool — runs kondi-council as a subprocess from within kondi-chat.
 *
 * The council manages its own context independently. Chat passes:
 *   - A brief (what to deliberate on)
 *   - Relevant file paths
 *   - The council profile to use
 *
 * The council runs, deliberates, and returns structured output.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { ToolDefinition } from '../types.ts';
import type { CouncilProfileManager } from './profiles.ts';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const COUNCIL_TOOL: ToolDefinition = {
  name: 'run_council',
  description: 'Run a multi-model deliberation council for complex decisions. Use for architecture reviews, security audits, major design decisions, or when you need multiple AI perspectives. This is expensive — use intentionally.',
  parameters: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: 'Council profile name (e.g., coding-cheap, coding-quality, analysis, debate, security-review)',
      },
      brief: {
        type: 'string',
        description: 'What to deliberate on — the problem statement',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relevant file paths to include as context',
      },
    },
    required: ['profile', 'brief'],
  },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeCouncil(
  profileName: string,
  brief: string,
  files: string[],
  workingDir: string,
  councilPath: string,
  profileManager: CouncilProfileManager,
): Promise<{ content: string; isError?: boolean }> {
  const profile = profileManager.get(profileName);
  if (!profile) {
    const available = profileManager.getAll().map(p => p.name).join(', ');
    return {
      content: `Unknown council profile: ${profileName}. Available: ${available}`,
      isError: true,
    };
  }

  process.stderr.write(`[council] Running ${profile.name} (${profile.tier}): ${brief.slice(0, 80)}\n`);
  process.stderr.write(`[council] Manager: ${profile.manager.model || profile.manager.provider}, ${profile.consultants.length} consultants, ${profile.maxRounds} rounds\n`);

  const args = profileManager.buildArgs(profile, brief, workingDir);

  try {
    const councilEntry = resolve(councilPath, 'src/cli/run-council.ts');
    const cmd = `npx tsx ${councilEntry} ${args.map(a => JSON.stringify(a)).join(' ')}`;

    const output = execSync(cmd, {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 300_000, // 5 minutes max
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Try to parse JSON output
    try {
      const result = JSON.parse(output);
      const summary = [
        `Council: ${profile.name} (${profile.councilType})`,
        `Status: ${result.status || 'completed'}`,
        '',
        result.decision ? `Decision:\n${result.decision}` : '',
        result.output ? `Output:\n${result.output}` : '',
        result.summary ? `Summary:\n${result.summary}` : '',
      ].filter(Boolean).join('\n');
      return { content: summary };
    } catch {
      // Not JSON — return raw output
      return { content: output.slice(-4000) };
    }
  } catch (error: any) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    return {
      content: `Council failed: ${error.message}\n${stderr.slice(-1000)}\n${stdout.slice(-1000)}`,
      isError: true,
    };
  }
}
