/**
 * First-run setup wizard.
 *
 * Called from the non-interactive path (or manually via `/wizard`). Writes a
 * minimal `.kondi-chat/config.json` if one does not already exist, and notes
 * which providers are likely configured based on environment variables.
 *
 * The wizard is non-interactive by default: it inspects the environment and
 * writes sensible defaults without blocking. An interactive stdin path can be
 * added later by a thin caller around this module.
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WizardResult {
  configPath: string;
  created: boolean;
  providersDetected: string[];
  defaultProfile: string;
}

const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
};

export function runFirstRunWizard(storageDir: string, opts: { interactive?: boolean } = {}): WizardResult {
  const configPath = join(storageDir, 'config.json');
  const providersDetected = Object.entries(PROVIDER_ENV)
    .filter(([, envVar]) => !!process.env[envVar])
    .map(([id]) => id);

  if (existsSync(configPath)) {
    return { configPath, created: false, providersDetected, defaultProfile: readProfile(configPath) };
  }

  const defaultProfile: WizardResult['defaultProfile'] = providersDetected.length === 0
    ? 'cheap'
    : providersDetected.includes('anthropic') ? 'balanced' : 'balanced';

  const config = {
    defaultProfile,
    providers: providersDetected,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  if (opts.interactive) {
    process.stderr.write(`[wizard] wrote ${configPath}\n`);
    process.stderr.write(`[wizard] detected providers: ${providersDetected.join(', ') || '(none — set an API key)'}\n`);
  }

  return { configPath, created: true, providersDetected, defaultProfile };
}

function readProfile(path: string): string {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof raw.defaultProfile === 'string' && raw.defaultProfile.length > 0) {
      return raw.defaultProfile;
    }
  } catch { /* ignore */ }
  return 'balanced';
}

/** Persist the active profile name to config.json, preserving other fields. */
export function writeActiveProfile(storageDir: string, name: string): void {
  const configPath = join(storageDir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch { /* start fresh on parse error */ }
  config.defaultProfile = name;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Read the persisted active profile from config.json (or 'balanced'). */
export function readActiveProfile(storageDir: string): string {
  return readProfile(join(storageDir, 'config.json'));
}

/**
 * Update-available banner. Fetches the latest release tag from GitHub, caches
 * for 24 hours under ~/.kondi-chat/.update-check. Never blocks startup.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  if (process.env.KONDI_NO_UPDATE_CHECK === '1') return null;
  try {
    const cachePath = join(process.env.HOME || '.', '.kondi-chat', '.update-check');
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { checkedAt: number; latest: string };
      if (Date.now() - cached.checkedAt < 24 * 60 * 60 * 1000) {
        return cached.latest !== currentVersion ? banner(cached.latest) : null;
      }
    }
    const resp = await fetch('https://api.github.com/repos/kondi/kondi-chat/releases/latest', {
      signal: AbortSignal.timeout(3000),
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { tag_name?: string };
    const latest = (data.tag_name || '').replace(/^v/, '');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now(), latest }));
    return latest && latest !== currentVersion ? banner(latest) : null;
  } catch {
    return null;
  }
}

function banner(latest: string): string {
  return `Update available: kondi-chat ${latest} — run \`npm install -g kondi-chat@latest\` or \`brew upgrade kondi-chat\``;
}
