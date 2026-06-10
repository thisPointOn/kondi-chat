#!/usr/bin/env node
// Join per-profile cost ledgers with SWE-bench evaluation reports into a
// markdown comparison table.
//
// Usage:
//   node bench/report.mjs --run <name> \
//     [--report quality=path/to/report.json] [--report best-value=path/to/report.json]
//
// The --report file is whatever the evaluator produced (sb-cli get-report
// output or the local harness <run_id>.json). Any of these keys are accepted
// for the list of solved instances: resolved_ids, resolved, resolved_instances.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const runIdx = args.indexOf('--run');
if (runIdx < 0) {
  console.error('Usage: node bench/report.mjs --run <name> [--report profile=report.json …]');
  process.exit(1);
}
const runName = args[runIdx + 1];
const runDir = join(benchDir, 'results', runName);
if (!existsSync(runDir)) {
  console.error(`No results at bench/results/${runName}`);
  process.exit(1);
}

const reports = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report') {
    const [profile, ...rest] = args[i + 1].split('=');
    reports[profile] = rest.join('=');
  }
}

function resolvedSet(reportPath) {
  const data = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const ids = data.resolved_ids || data.resolved || data.resolved_instances;
  if (!Array.isArray(ids)) {
    console.error(`Could not find a resolved-ids array in ${reportPath}`);
    return null;
  }
  return new Set(ids);
}

const rows = [];
for (const profile of readdirSync(runDir)) {
  const costsPath = join(runDir, profile, 'costs.jsonl');
  if (!existsSync(costsPath)) continue;
  const costs = readFileSync(costsPath, 'utf-8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));

  const total = costs.length;
  const totalCost = costs.reduce((s, c) => s + (c.costUsd || 0), 0);
  const emptyPatches = costs.filter(c => !c.patchBytes).length;
  const models = [...new Set(costs.flatMap(c => c.modelsUsed || []))];

  let resolved = null;
  if (reports[profile]) {
    const set = resolvedSet(reports[profile]);
    if (set) resolved = costs.filter(c => set.has(c.instance_id)).length;
  }

  rows.push({
    profile, total, resolved, totalCost,
    avgCost: total ? totalCost / total : 0,
    costPerResolved: resolved ? totalCost / resolved : null,
    emptyPatches, models,
  });
}

if (rows.length === 0) {
  console.error('No costs.jsonl files found in', runDir);
  process.exit(1);
}

const fmt = n => `$${n.toFixed(2)}`;
console.log(`## kondi-chat SWE-bench Lite subset — run \`${runName}\`\n`);
console.log('| Profile | Resolved | Total cost | Avg cost/task | Cost per solve | Empty patches |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  const res = r.resolved === null ? 'n/a (no --report)' : `${r.resolved}/${r.total}`;
  const cps = r.costPerResolved === null ? '—' : fmt(r.costPerResolved);
  console.log(`| ${r.profile} | ${res} | ${fmt(r.totalCost)} | ${fmt(r.avgCost)} | ${cps} | ${r.emptyPatches} |`);
}
console.log('');
for (const r of rows) {
  console.log(`**${r.profile}** models used: ${r.models.join(', ') || 'unknown'}`);
}
