/**
 * Council Tool — runs the bundled kondi-council engine as a subprocess.
 *
 * The deliberation engine is vendored at `src/council-engine/` (no
 * external repo required). Chat passes a brief, a working directory, and
 * a council profile; the engine deliberates and returns structured JSON.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../types.ts';
import type { CouncilProfileManager } from './profiles.ts';

// Bundled engine entry point — resolved relative to this module so it
// works regardless of where kondi-chat was launched from.
const ENGINE_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'council-engine', 'cli', 'run-council.ts',
);

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
        description: 'Council profile id (e.g., coding, analysis, debate, code-planning)',
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
  _files: string[],
  workingDir: string,
  profileManager: CouncilProfileManager,
): Promise<{ content: string; isError?: boolean }> {
  const profile = profileManager.get(profileName);
  if (!profile) {
    const available = profileManager.ids().join(', ') || '(none)';
    return {
      content: `Unknown council profile: ${profileName}. Available: ${available}`,
      isError: true,
    };
  }

  const configPath = profileManager.getPath(profileName);
  process.stderr.write(
    `[council] Running ${profileName} (${profile.type || 'council'}): ${brief.slice(0, 80)}\n`,
  );

  // Engine CLI contract — see src/council-engine/cli/run-council.ts.
  // --output none keeps the user's working dir clean; --json-stdout still
  // emits the structured result on stdout regardless.
  const args = [
    '--config', configPath,
    '--task', brief,
    '--working-dir', workingDir,
    '--output', 'none',
    '--json-stdout',
    '--no-session-export',
    '--quiet',
  ];

  try {
    const cmd = `npx tsx ${JSON.stringify(ENGINE_ENTRY)} ${args.map(a => JSON.stringify(a)).join(' ')}`;
    const output = execSync(cmd, {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 600_000, // 10 min — councils fan out across models for multiple rounds
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // The engine writes some internal logs to stdout; the --json-stdout
    // result is a single JSON line. Extract the last line that parses.
    const result = parseLastJson(output);
    if (result) {
      const summary = [
        `Council: ${profile.name} (${profile.type || 'council'})`,
        `Status: ${result.status || 'completed'}`,
        '',
        result.decision ? `Decision:\n${result.decision}` : '',
        result.output ? `Output:\n${result.output}` : '',
        result.summary ? `Summary:\n${result.summary}` : '',
      ].filter(Boolean).join('\n');
      return { content: summary };
    }
    // No JSON found — return the tail of raw output as a fallback.
    return { content: output.slice(-4000) };
  } catch (error: any) {
    const stderr = (error.stderr?.toString() || '').slice(-1000);
    const stdout = (error.stdout?.toString() || '').slice(-1000);
    return {
      content: `Council failed: ${error.message}\n${stderr}\n${stdout}`,
      isError: true,
    };
  }
}

/** Scan output lines bottom-up for the last one that parses as a JSON object. */
function parseLastJson(output: string): any | undefined {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        return JSON.parse(line);
      } catch {
        /* keep scanning */
      }
    }
  }
  return undefined;
}
