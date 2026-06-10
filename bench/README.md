# SWE-bench Lite provider shootout

Runs the *same agent* (kondi-chat) against the *same* SWE-bench Lite subset
once per provider — Anthropic, OpenAI, Google, Z.AI, DeepSeek — and compares
solve rate and cost per solved task. Single-provider profiles live in
`bench/profiles/` (each pins every agent phase to one provider's models via
`rolePinning` + `allowedProviders`); any other profile name (e.g. `quality`,
`best-value`) works too.

## How it works

1. `fetch-tasks.mjs` pulls a deterministic subset of SWE-bench Lite (test
   split) from HuggingFace. Gold/test patches are never saved — the agent
   only sees the issue text.
2. `run.mjs` clones each task's repo at its base commit into a scratch dir,
   runs `kondi-chat` headlessly (`--pipe --json --dangerously-skip-permissions`)
   with the issue as the prompt, and records the resulting `git diff` plus the
   cost ledger from the JSON payload. Output is standard SWE-bench
   `predictions.jsonl` per profile.
3. Predictions are evaluated with the official SWE-bench harness (cloud via
   `sb-cli`, or locally with Docker).
4. `report.mjs` joins solve results with costs into a markdown table.

## Running it

```bash
# 1. Pick the subset (deterministic — same seed, same tasks)
node bench/fetch-tasks.mjs --count 20 --seed 42

# 2. Sanity-check the plumbing without spending API money
node bench/run.mjs --dry-run

# 3. Run for real (sequential; expect minutes per task). Default profiles:
#    bench-anthropic,bench-openai,bench-google,bench-zai,bench-deepseek
node bench/run.mjs --run launch --max-cost 2 --max-iterations 25

# 4. Evaluate (cloud, free — see https://github.com/swe-bench/sb-cli)
pip install sb-cli
export SWEBENCH_API_KEY=...   # sb-cli gen-api-key your@email
sb-cli submit swe-bench_lite test \
  --predictions_path bench/results/launch/bench-anthropic/predictions.jsonl \
  --run_id kondi-anthropic-launch
sb-cli get-report swe-bench_lite test kondi-anthropic-launch -o bench/results/launch/bench-anthropic/
# …repeat for each profile…

# 5. Final table
node bench/report.mjs --run launch \
  --report bench-anthropic=bench/results/launch/bench-anthropic/kondi-anthropic-launch.json \
  --report bench-zai=bench/results/launch/bench-zai/kondi-zai-launch.json
  # …one --report per profile…
```

Local evaluation alternative (needs Docker + ~30 GB disk for images):

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path bench/results/launch/bench-anthropic/predictions.jsonl \
  --max_workers 4 --run_id kondi-anthropic-launch
```

## Notes

- API keys come from `~/.kondi-chat/.env` as usual. The profile is set per
  scratch dir via `.kondi-chat/config.json`, so your global default is untouched.
- Re-running `run.mjs` skips instances already present in `predictions.jsonl`
  — safe to interrupt and resume.
- Repo clones are cached in `bench/cache/` (a few GB total for the Lite
  repos: django, sympy, sphinx, etc.). Scratch dirs are deleted after each
  task unless `--keep-work`.
- The prompt tells the agent the dev environment is not installed and not to
  run tests — verification happens only in the official harness.
- Caps default to $2 / 25 iterations / 15 min per task. A 20-task × 5-profile
  run is bounded at $200 worst case; in practice expect far less (Gemini and
  GLM-flash legs are mostly free-tier, DeepSeek/GLM are cheap per token).
  Tighten with `--max-cost` if needed.
