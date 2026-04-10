# Configuration

All config lives under `.kondi-chat/` in your project, with some files under
`~/.kondi-chat/` for user-level defaults.

## `config.json`

Auto-created on first run from the wizard.

```json
{
  "defaultProfile": "balanced",
  "providers": ["anthropic", "openai"]
}
```

## `permissions.json`

```json
{
  "defaultTier": "confirm",
  "tools": {
    "read_file": "auto-approve",
    "write_file": "confirm",
    "run_command": "confirm"
  },
  "alwaysConfirmPatterns": [
    "rm\\s+(-[rfR]+\\s+|--recursive)",
    "git\\s+push\\s+(-f|--force)",
    "sudo\\s+"
  ]
}
```

Tiers: `auto-approve`, `confirm`, `always-confirm` (cannot be auto-approved
from config).

## `hooks.json`

```json
{
  "hooks": {
    "after_write_file": "npx prettier --write {path}",
    "after_edit_file": ["npx prettier --write {path}", "npx eslint --fix {path}"]
  },
  "builtin": { "autoFormat": true },
  "defaultFailureMode": "warn",
  "defaultTimeoutMs": 15000
}
```

Variables: `{path}`, `{command}`, `{content}`, `{result}`, `{cwd}`.

## `rate-limits.json`

Per-provider RPM/TPM budgets. Auto-created on first run.

```json
{
  "limits": {
    "anthropic": { "rpm": 50, "tpm": 400000, "maxConcurrent": 10 },
    "openai":    { "rpm": 30, "tpm": 150000, "maxConcurrent": 10 }
  }
}
```

## `telemetry.json`

Opt-in local telemetry. Controlled via `/telemetry enable`/`disable`. No
network in v1.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY` | Provider auth |
| `BRAVE_SEARCH_API_KEY` | Enables web_search / web_fetch (Spec 11) |
| `KONDI_CHAT_NO_TELEMETRY=1` | Forces telemetry off and deletes local data on load |
| `KONDI_NO_UPDATE_CHECK=1` | Skip the 24-hour update check |
| `KONDI_CONFIG_DIR` | Override `.kondi-chat/` location |
