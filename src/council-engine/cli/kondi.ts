#!/usr/bin/env -S npx tsx
/**
 * Kondi CLI — Multi-LLM Council Platform
 *
 * Usage:
 *   kondi council [options]     Run a council deliberation
 *   kondi pipeline [options]    Run a pipeline
 *   kondi --help                Show help
 *   kondi --version             Show version
 */

// Load .env if present (API keys)
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
for (const envPath of [resolve(process.cwd(), '.env'), resolve(__dirnameLocal, '..', '..', '.env')]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    break;
  }
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

function printHelp() {
  console.log(`
${C.bold}${C.cyan}Kondi${C.reset} — Multi-LLM Council Platform

${C.bold}Commands:${C.reset}
  council     Run a council deliberation
  pipeline    Run a pipeline from JSON

${C.bold}Usage:${C.reset}
  kondi council --task "Review this code" --working-dir ./myapp
  kondi council --config council.json
  kondi council exported-council.json
  kondi pipeline pipeline.json --working-dir ./project

${C.bold}Options:${C.reset}
  --help, -h       Show help (use "kondi council --help" for subcommand help)
  --version, -v    Show version

Run ${C.dim}kondi <command> --help${C.reset} for subcommand-specific options.
`);
}

async function main() {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    process.exit(0);
  }

  if (subcommand === '--version' || subcommand === '-v') {
    try {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
      console.log(`kondi ${pkg.version || '0.0.0'}`);
    } catch {
      console.log('kondi 0.0.0');
    }
    process.exit(0);
  }

  // Strip the subcommand from argv so the sub-runner sees the right args
  process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

  switch (subcommand) {
    case 'council':
      await import('./run-council');
      break;
    case 'pipeline':
      await import('./run-pipeline');
      break;
    default:
      console.error(`Unknown command: ${subcommand}`);
      console.error(`Run "kondi --help" for available commands.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
