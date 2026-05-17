/**
 * Interactive API-key setup wizard.
 *
 * Drives a multi-step prompt over the JSON-RPC protocol: the backend emits
 * `wizard_prompt` events, the TUI renders a modal and replies with a
 * `wizard_response` command. `WizardManager` bridges that round-trip into
 * awaitable promises — the same shape as `PermissionManager`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelRegistry } from '../router/registry.ts';

interface WizardStepResult {
  value: string;
  cancelled: boolean;
}

export class WizardManager {
  private pending: ((r: WizardStepResult) => void) | null = null;
  private counter = 0;

  constructor(private emit: (event: Record<string, unknown>) => void) {}

  /** True while a wizard step is awaiting a TUI response. */
  get active(): boolean {
    return this.pending !== null;
  }

  private prompt(opts: {
    step: 'select' | 'input';
    title: string;
    options?: string[];
    masked?: boolean;
    hint?: string;
  }): Promise<WizardStepResult> {
    const id = `wiz-${Date.now()}-${this.counter++}`;
    this.emit({
      type: 'wizard_prompt',
      id,
      step: opts.step,
      title: opts.title,
      options: opts.options ?? [],
      masked: opts.masked ?? false,
      hint: opts.hint ?? '',
    });
    return new Promise<WizardStepResult>((resolve) => {
      this.pending = resolve;
    });
  }

  /** Ask the user to pick one of `options`. Resolves with the chosen index. */
  select(title: string, options: string[]): Promise<WizardStepResult> {
    return this.prompt({ step: 'select', title, options });
  }

  /** Ask the user to type a value. `masked` renders the input as dots. */
  input(title: string, hint: string, masked = true): Promise<WizardStepResult> {
    return this.prompt({ step: 'input', title, hint, masked });
  }

  /** Called by the backend when a `wizard_response` command arrives. */
  handleResponse(_id: string, value: string, cancelled: boolean): void {
    const resolve = this.pending;
    this.pending = null;
    if (resolve) resolve({ value, cancelled });
  }

  /** Dismiss the TUI modal with a closing message. */
  done(message: string): void {
    this.emit({ type: 'wizard_done', message });
  }
}

interface ProviderEntry {
  name: string;
  env: string;
  hint: string;
}

/** Providers offered by the key wizard. Ollama is local and needs no key. */
const KEY_PROVIDERS: ProviderEntry[] = [
  { name: 'Anthropic — Claude', env: 'ANTHROPIC_API_KEY', hint: 'from the Anthropic console' },
  { name: 'Google — Gemini (free tier available)', env: 'GOOGLE_API_KEY', hint: 'from Google AI Studio' },
  { name: 'Z.AI — GLM (free GLM-4.5-flash)', env: 'ZAI_API_KEY', hint: 'from the Z.AI Coding Plan' },
  { name: 'OpenAI — GPT', env: 'OPENAI_API_KEY', hint: 'from the OpenAI platform console' },
  { name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', hint: 'from the DeepSeek platform console' },
  { name: 'xAI — Grok', env: 'XAI_API_KEY', hint: 'from the xAI console' },
];

/**
 * Upsert a `KEY=value` line in `~/.kondi-chat/.env` — the user-level env
 * file the backend loads on every start. Existing line is replaced.
 */
function writeEnvKey(envVar: string, value: string): string {
  const dir = join(homedir(), '.kondi-chat');
  mkdirSync(dir, { recursive: true });
  const envPath = join(dir, '.env');

  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, 'utf-8').split('\n');
  }
  const idx = lines.findIndex((l) => l.trim().startsWith(`${envVar}=`));
  const newLine = `${envVar}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(newLine);
  }
  writeFileSync(envPath, lines.join('\n') + '\n');
  try {
    chmodSync(envPath, 0o600); // best-effort — the file holds secrets
  } catch {
    /* chmod is a no-op / may throw on Windows — ignore */
  }
  return envPath;
}

/**
 * Run the interactive key-setup wizard end to end: pick a provider, collect
 * the key, persist it to `~/.kondi-chat/.env`, and re-check model
 * availability so the key takes effect without restarting kondi-chat.
 */
export async function runKeySetup(
  wizard: WizardManager,
  registry: ModelRegistry,
): Promise<void> {
  const sel = await wizard.select(
    'Add an API key — pick a provider',
    KEY_PROVIDERS.map((p) => p.name),
  );
  if (sel.cancelled) {
    wizard.done('Key setup cancelled.');
    return;
  }

  const provider = KEY_PROVIDERS[parseInt(sel.value, 10)];
  if (!provider) {
    wizard.done('Key setup cancelled — no provider chosen.');
    return;
  }

  const keyResp = await wizard.input(
    `Paste your ${provider.name} key`,
    `Sets ${provider.env} ${provider.hint}. Input is masked and is not echoed into scrollback.`,
    true,
  );
  if (keyResp.cancelled) {
    wizard.done('Key setup cancelled.');
    return;
  }

  const key = keyResp.value.trim();
  if (!key) {
    wizard.done('Key setup cancelled — no key entered.');
    return;
  }

  let envPath: string;
  try {
    envPath = writeEnvKey(provider.env, key);
  } catch (e) {
    wizard.done(`Could not save the key: ${(e as Error).message}`);
    return;
  }

  // Make the key live for the running backend, then re-check availability
  // so models light up immediately — no restart needed.
  process.env[provider.env] = key;
  await registry.checkHealth();
  const available = registry.getAvailable();

  wizard.done(
    `${provider.env} saved to ${envPath}. ` +
      `${available.length} model${available.length === 1 ? '' : 's'} now available` +
      `${available.length > 0 ? ' — you can start a turn.' : '.'}`,
  );
}
