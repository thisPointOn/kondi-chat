#!/usr/bin/env node
// Run kondi-chat headlessly against bench/tasks.json for one or more budget
// profiles. Produces, per profile:
//   bench/results/<run>/<profile>/predictions.jsonl  (SWE-bench format)
//   bench/results/<run>/<profile>/costs.jsonl        (per-task cost ledger)
//
// Already-completed instances (present in predictions.jsonl) are skipped, so
// the runner is safe to re-run after an interruption.
//
// Usage:
//   node bench/run.mjs --profiles quality,best-value \
//     [--run <name>] [--max-cost 2] [--max-iterations 25] \
//     [--timeout-min 15] [--keep-work] [--dry-run]

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync,
  readdirSync, copyFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, '..');

const args = process.argv.slice(2);
const str = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseFloat(args[i + 1]) : dflt;
};
const profiles = str(
  '--profiles',
  'bench-anthropic,bench-openai,bench-google,bench-zai,bench-deepseek',
).split(',').map(s => s.trim()).filter(Boolean);
const runName = str('--run', new Date().toISOString().slice(0, 10));
const maxCost = num('--max-cost', 2);
const maxIterations = num('--max-iterations', 25);
const timeoutMin = num('--timeout-min', 15);
const keepWork = args.includes('--keep-work');
const dryRun = args.includes('--dry-run');

const tasksPath = join(benchDir, 'tasks.json');
if (!existsSync(tasksPath)) {
  console.error('bench/tasks.json not found — run `node bench/fetch-tasks.mjs` first.');
  process.exit(1);
}
const tasks = JSON.parse(readFileSync(tasksPath, 'utf-8'));

// Resolve the package-local tsx CLI (same approach as bin/kondi-chat.js).
const require = createRequire(join(repoRoot, 'package.json'));
const tsxPkgPath = require.resolve('tsx/package.json');
const tsxPkg = JSON.parse(readFileSync(tsxPkgPath, 'utf-8'));
const tsxCli = join(dirname(tsxPkgPath), typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx);
const backend = join(repoRoot, 'src', 'cli', 'backend.ts');

const cacheDir = join(benchDir, 'cache');
const workRoot = join(benchDir, 'work');
mkdirSync(cacheDir, { recursive: true });

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function ensureCache(repo) {
  const dir = join(cacheDir, repo.replace('/', '__') + '.git');
  if (!existsSync(dir)) {
    console.log(`  cloning ${repo} (one-time, cached)…`);
    execFileSync('git', ['clone', '--bare', `https://github.com/${repo}.git`, dir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  return dir;
}

function prepareWorkdir(task, profile) {
  const workdir = join(workRoot, profile, task.instance_id);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(dirname(workdir), { recursive: true });
  const cache = ensureCache(task.repo);
  execFileSync('git', ['clone', '--no-checkout', cache, workdir], { stdio: 'ignore' });
  git(workdir, 'checkout', '-q', task.base_commit);
  appendFileSync(join(workdir, '.git', 'info', 'exclude'), '.kondi-chat/\n');
  const storage = join(workdir, '.kondi-chat');
  // Make the bench profiles (bench/profiles/*.json) available in the scratch
  // dir — project-level profiles override built-ins on name collision.
  const profileSrc = join(benchDir, 'profiles');
  const profileDst = join(storage, 'profiles');
  mkdirSync(profileDst, { recursive: true });
  for (const f of readdirSync(profileSrc).filter(f => f.endsWith('.json'))) {
    copyFileSync(join(profileSrc, f), join(profileDst, f));
  }
  writeFileSync(join(storage, 'config.json'), JSON.stringify({ defaultProfile: profile }, null, 2));
  return workdir;
}

function buildPrompt(task) {
  return [
    'You are fixing a real GitHub issue in this repository. The repo is already',
    'checked out at the relevant commit.',
    '',
    '<issue>',
    task.problem_statement.trim(),
    '</issue>',
    '',
    'Requirements:',
    '- Find the root cause by reading the source code, then make a minimal, focused fix.',
    '- Modify source code only. Do NOT modify or add tests.',
    '- The dev environment for this repo is NOT installed: do not try to install',
    '  dependencies or run the test suite. Verify your fix by reasoning about the code.',
    '- When done, briefly state which file(s) you changed and why.',
  ].join('\n');
}

// The backend prints a pretty-printed JSON payload at the end of stdout.
// Find the last line that is exactly "{" and parse from there.
function parseFinalJson(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '{') {
      try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep scanning */ }
    }
  }
  return null;
}

function runAgent(workdir, prompt) {
  return new Promise(res => {
    const child = spawn(process.execPath, [
      tsxCli, backend,
      '--pipe', '--json',
      '--dangerously-skip-permissions',
      '--max-iterations', String(maxIterations),
      '--max-cost', String(maxCost),
      '--cwd', workdir,
    ], {
      cwd: workdir,
      env: { ...process.env, KONDI_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMin * 60 * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      res({ code, timedOut: signal === 'SIGKILL', stdout, stderr });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractPatch(workdir) {
  git(workdir, 'add', '-A');
  return git(workdir, 'diff', '--cached');
}

function loadDone(predictionsPath) {
  const done = new Set();
  if (!existsSync(predictionsPath)) return done;
  for (const line of readFileSync(predictionsPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).instance_id); } catch { /* skip */ }
  }
  return done;
}

for (const profile of profiles) {
  const outDir = join(benchDir, 'results', runName, profile);
  mkdirSync(outDir, { recursive: true });
  const predictionsPath = join(outDir, 'predictions.jsonl');
  const costsPath = join(outDir, 'costs.jsonl');
  const done = loadDone(predictionsPath);

  console.log(`\n=== profile: ${profile} (${tasks.length} tasks, ${done.size} already done) ===`);

  for (const task of tasks) {
    if (done.has(task.instance_id)) {
      console.log(`- ${task.instance_id}: skipped (already in predictions)`);
      continue;
    }
    console.log(`- ${task.instance_id}: preparing workdir…`);
    const workdir = prepareWorkdir(task, profile);

    if (dryRun) {
      console.log(`  dry-run: would run agent in ${workdir}`);
      console.log(`  prompt preview: ${buildPrompt(task).slice(0, 120).replace(/\n/g, ' ')}…`);
      if (!keepWork) rmSync(workdir, { recursive: true, force: true });
      continue;
    }

    const started = Date.now();
    console.log(`  running agent (caps: ${maxIterations} iters, $${maxCost}, ${timeoutMin} min)…`);
    const { code, timedOut, stdout, stderr } = await runAgent(workdir, buildPrompt(task));
    const payload = parseFinalJson(stdout);
    const patch = extractPatch(workdir);

    const stats = payload?.stats || {};
    const record = {
      instance_id: task.instance_id,
      profile,
      exitCode: code,
      timedOut,
      costUsd: stats.costUsd ?? 0,
      inputTokens: stats.inputTokens ?? 0,
      outputTokens: stats.outputTokens ?? 0,
      iterations: payload?.iterations ?? 0,
      modelsUsed: stats.modelsUsed ?? [],
      durationMs: Date.now() - started,
      patchBytes: Buffer.byteLength(patch),
    };
    appendFileSync(costsPath, JSON.stringify(record) + '\n');
    appendFileSync(predictionsPath, JSON.stringify({
      instance_id: task.instance_id,
      model_name_or_path: `kondi-chat__${profile}`,
      model_patch: patch,
    }) + '\n');

    if (payload === null) {
      writeFileSync(join(outDir, `${task.instance_id}.stdout.log`), stdout);
      writeFileSync(join(outDir, `${task.instance_id}.stderr.log`), stderr);
      console.log(`  WARNING: no JSON payload found (exit ${code}${timedOut ? ', timed out' : ''}) — logs saved`);
    }
    console.log(
      `  done: exit ${code}${timedOut ? ' (timeout)' : ''}, $${record.costUsd.toFixed(4)}, ` +
      `${record.iterations} iters, patch ${record.patchBytes} bytes`,
    );
    if (!keepWork) rmSync(workdir, { recursive: true, force: true });
  }

  console.log(`\nProfile ${profile} complete → ${predictionsPath}`);
}

console.log('\nNext: evaluate the predictions (see bench/README.md), then run bench/report.mjs.');
