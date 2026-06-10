#!/usr/bin/env node
// Fetch a deterministic subset of SWE-bench Lite (test split) into
// bench/tasks.json. Only metadata the agent is allowed to see is saved —
// the gold patch and test patch are deliberately dropped.
//
// Usage: node bench/fetch-tasks.mjs [--count 20] [--seed 42]

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1], 10) : dflt;
};
const count = num('--count', 20);
const seed = num('--seed', 42);

const BASE =
  'https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test';

const rows = [];
for (let offset = 0; offset < 300; offset += 100) {
  const resp = await fetch(`${BASE}&offset=${offset}&length=100`);
  if (!resp.ok) throw new Error(`HF datasets-server ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  for (const r of data.rows) rows.push(r.row);
  if (data.rows.length < 100) break;
}
if (rows.length === 0) throw new Error('No rows returned from datasets-server');

// Deterministic shuffle (mulberry32) so --seed reproduces the same subset.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}

const picked = rows.slice(0, count).map(r => ({
  instance_id: r.instance_id,
  repo: r.repo,
  base_commit: r.base_commit,
  problem_statement: r.problem_statement,
}));
picked.sort((a, b) => a.instance_id.localeCompare(b.instance_id));

writeFileSync(join(benchDir, 'tasks.json'), JSON.stringify(picked, null, 2) + '\n');
console.log(`Wrote ${picked.length} tasks to bench/tasks.json (seed ${seed}, pool ${rows.length})`);
for (const t of picked) console.log(`  ${t.instance_id}`);
