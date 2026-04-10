# 16 — Packaging

## Product Description

Packaging makes kondi-chat trivial to install across platforms. Users can run `npm install -g kondi-chat`, `brew install kondi-chat`, or download a standalone binary that bundles the Rust TUI and the Node.js backend. Docker images provide a server mode for CI. A first-run setup wizard guides API key configuration. Auto-update checks keep users current.

**Why it matters:** Distribution is where tools live or die. If installing kondi-chat takes 15 minutes and requires cloning a repo and running `pnpm install`, most potential users give up. First-class packaging across npm, Homebrew, standalone binaries, and Docker unlocks adoption.

**Revised 2026-04-10 (simplification pass):** v1 ships **three channels: npm, Homebrew, Docker**. Standalone single-binary (Node SEA) is deferred to v2 — SEA is experimental, fragile around MCP subprocess spawning, and the Homebrew install already gives a near-single-binary experience for macOS. Auto-update self-replace deferred too; v1 prints "update available — run `npm install -g kondi-chat@latest`" / "brew upgrade" and that's the whole feature. Deleted `src/cli/updater.ts` — version check is ~20 lines inline in `main.tsx`. Effort dropped from 6 days to 2.5 days.

## User Stories

1. **npm install:** A Node.js developer runs `npm install -g kondi-chat`. The package installs the Node backend and downloads a pre-built Rust TUI binary matching their platform. They run `kondi-chat` and it works.

2. **Homebrew on macOS:** A Mac user runs `brew install kondi-chat`. The formula downloads a single universal binary, adds it to `/usr/local/bin`, and they're ready to go. The binary contains both the TUI and a bundled Node runtime.

3. **Standalone binary for Linux:** A Linux user downloads `kondi-chat-linux-x64.tar.gz` from GitHub releases, extracts, and runs. No Node or Rust needed — everything is in the single binary. Works on vanilla Ubuntu/Debian/Alpine.

4. **First-run wizard:** A new user runs `kondi-chat` for the first time. The wizard asks: "Which providers do you want to use? [Anthropic, OpenAI, DeepSeek, Gemini, Ollama]" — they pick Anthropic. Next: "Enter your API key (or set ANTHROPIC_API_KEY later):". Finally: "Default profile? [balanced, cheap, quality]". Config is written to `~/.kondi-chat/config.json` and they're in the chat.

5. **Docker for CI:** A CI pipeline uses `docker run ghcr.io/kondi/kondi-chat:latest --prompt "review this PR"`. The Docker image is a minimal Alpine-based image with kondi-chat pre-installed.

## Clarifications (2026-04-10)

- **Single-binary promise:** Specify which artifacts are truly single-file (e.g., GitHub release tarballs). Homebrew/NPM may install multiple files (TUI + backend); document the layout and temp extraction/cleanup.
- **Integrity:** All download paths must verify checksums/signatures; self-update must verify before replace. Define signature source and failure behavior (fail closed).
- **Wizard precedence:** env vars > config.json > .env. If the wizard is interrupted, leave files untouched; never write partial config. Document secret handling for API keys stored in .env.
- **Platform support:** State musl/static-link requirements and runtime deps for Alpine; include health check for Docker image.
- **Auto-update:** Define channels (stable/beta), offline behavior, and rate-limit handling. If npm/brew can’t auto-update, say so and provide exact manual commands.
- **Tests:** Add Windows install/runtime, checksum verification, uninstall/upgrade, and non-TTY wizard tests.
## Technical Design

### Distribution channels (v1)

| Channel | Target | Artifact | Build method |
|---------|--------|----------|-------------|
| npm | JS developers | `kondi-chat` package with `postinstall` that downloads platform TUI binary | `npm publish` in CI |
| Homebrew | macOS users | Formula pointing to GitHub release tarball (TUI + bundled backend.js) | Update tap repo in CI |
| Docker | CI/CD | Alpine-based image with TUI + Node + backend.js | `docker build` in CI |

GitHub release tarballs (a TUI binary + `backend.js` + a small entrypoint) are produced by CI as the upstream artifact for npm postinstall and Homebrew. **Standalone single-file SEA binary deferred.** **`cargo install` deferred.**

### Bundling (v1)

The backend is bundled to a single `dist/backend.js` via `esbuild`. The Rust TUI binary spawns `node dist/backend.js` as a subprocess. All three v1 channels (npm, Homebrew, Docker) require `node` on the host (via dependency, postinstall, or base image). The npm path uses the user's existing Node; the Homebrew formula declares `depends_on "node"`; the Docker image installs `nodejs` from Alpine.

Single-binary SEA bundling deferred. **Revised:** SEA is experimental and adds friction (postject fragility, MCP subprocess argv quirks) without delivering meaningfully more user value than `brew install kondi-chat`. Revisit when Node SEA stabilises.

### Update banner

On startup, kondi-chat checks `https://api.github.com/repos/user/kondi-chat/releases/latest` (cached for 24 hours in `~/.kondi-chat/.update-check`). If a newer version is available, it prints a one-line banner with the right command for the detected install method (`npm install -g kondi-chat@latest` or `brew upgrade kondi-chat`).

No `--update` self-replace flag in v1. Opt out via `KONDI_NO_UPDATE_CHECK=1`. **Revised:** self-update binary replace deferred — for npm/brew users it's the wrong abstraction anyway; just point them at the right command.

## Implementation Details

### npm package

**`package.json`:**

```json
{
  "name": "kondi-chat",
  "version": "0.1.0",
  "bin": {
    "kondi-chat": "./bin/kondi-chat.js"
  },
  "files": ["bin/", "dist/", "README.md"],
  "scripts": {
    "postinstall": "node scripts/download-tui.js",
    "bundle": "esbuild src/cli/backend.ts --bundle --platform=node --outfile=dist/backend.js",
    "build": "npm run bundle && npm run build:tui"
  }
}
```

**`bin/kondi-chat.js`** — entry point:

```javascript
#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const platform = `${process.platform}-${process.arch}`;
const tuiBin = join(__dirname, '..', 'dist', 'tui', platform, 'kondi-tui');
spawn(tuiBin, process.argv.slice(2), { stdio: 'inherit' });
```

**`scripts/download-tui.js`:** downloads platform-specific prebuilt TUI binary from GitHub releases during `postinstall`.

### Homebrew formula

**`Formula/kondi-chat.rb`:**

```ruby
class KondiChat < Formula
  desc "Multi-model AI coding CLI"
  homepage "https://github.com/user/kondi-chat"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/user/kondi-chat/releases/download/v0.1.0/kondi-chat-darwin-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "https://github.com/user/kondi-chat/releases/download/v0.1.0/kondi-chat-darwin-x64.tar.gz"
      sha256 "..."
    end
  end

  def install
    bin.install "kondi-chat"
    bin.install "kondi-backend"
  end

  test do
    assert_match "kondi-chat", shell_output("#{bin}/kondi-chat --version")
  end
end
```

### Docker image

**`Dockerfile`:**

```dockerfile
FROM alpine:3.19 AS base
RUN apk add --no-cache nodejs git
COPY dist/tui/linux-x64/kondi-tui /usr/local/bin/kondi-chat
COPY dist/backend.js /usr/local/lib/kondi-chat/backend.js
ENV KONDI_BACKEND=/usr/local/lib/kondi-chat/backend.js
WORKDIR /workspace
ENTRYPOINT ["kondi-chat"]
CMD ["--help"]
```

Build with `docker build -t kondi-chat:latest .`

Published to GitHub Container Registry as `ghcr.io/user/kondi-chat:latest`.

### First-run setup wizard

**`src/cli/wizard.ts`** (new):

```typescript
export interface WizardResult {
  providers: ProviderId[];
  apiKeys: Partial<Record<ProviderId, string>>;
  defaultProfile: string;
  completed: boolean;
}

export async function runSetupWizard(configDir: string): Promise<WizardResult>;

export function needsSetup(configDir: string): boolean;
```

The wizard is triggered:
- On first run (no config file exists)
- Explicitly via `kondi-chat setup`

It runs as a minimal TUI (separate from the main chat TUI) using readline prompts, so it works on any terminal including non-TTY fallback to `--prompt`-style questions.

Wizard flow:

1. Welcome message
2. Provider selection (multi-select)
3. For each selected provider, API key input (or "skip, use env var")
4. Default profile (radio select)
5. Enable telemetry? (radio select, default off)
6. Write config to `~/.kondi-chat/config.json` and `.env`
7. "Setup complete. Try `kondi-chat` to start."

### Update check

Inlined in `src/cli/main.tsx` (~25 lines): fetch `releases/latest`, compare semver against `package.json` version, write a `.update-check` cache file with timestamp + latest version, print a single status line if newer. Install-method detection is a simple `argv[0]` check (`/Cellar/` → brew, `/lib/node_modules/` → npm, else unknown).

No `src/cli/updater.ts` file. **Revised:** the entire updater module collapsed to one inlined helper.

### Modified files

**`src/cli/main.tsx`**

- On startup, call `needsSetup()` and launch wizard if needed
- Call `checkForUpdates()` in the background; emit status event if update available

**`src/cli/backend.ts`**

- Read `KONDI_BACKEND` env var for Docker mode, or fall back to argv detection

## Protocol Changes

None. Packaging is outside the TUI <-> backend protocol.

## Configuration

**`~/.kondi-chat/config.json`** (global user config):

```json
{
  "version": 1,
  "defaultProfile": "balanced",
  "providers": ["anthropic", "openai"],
  "autoUpdate": true,
  "updateCheckIntervalMs": 86400000,
  "firstRunAt": "2026-04-06T10:00:00Z"
}
```

Environment variables:
- `KONDI_CONFIG_DIR` — override config location (default: `~/.kondi-chat`)
- `KONDI_NO_UPDATE_CHECK` — disable auto-update check
- `KONDI_BACKEND` — path to backend binary (for custom installs)

## Error Handling

| Scenario | Handling |
|----------|----------|
| postinstall TUI download fails | Warn user, provide manual install instructions |
| Unsupported platform | Error with list of supported platforms |
| Self-update fails (disk full, permissions) | Roll back, keep old binary, show error |
| Update check offline | Silent; retry next day |
| Wizard aborted (^C) | Write partial config, warn "setup incomplete" |
| Corrupted global config | Re-run wizard |
| Conflicting install methods (npm + brew) | Both work independently; warn if PATH has duplicates |

## Testing Plan

1. **Build tests** (CI):
   - `npm pack` produces a valid tarball
   - Homebrew formula builds and installs on macos-latest
   - Docker image builds and `docker run` executes
   - Each platform binary builds via matrix (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win-x64)

2. **Install tests** (E2E, in CI matrix):
   - Fresh ubuntu:latest -> npm install -g kondi-chat -> kondi-chat --version
   - Fresh macos -> brew install kondi-chat -> kondi-chat --version
   - docker pull -> docker run -> kondi-chat --version
   - Download tarball -> extract -> run

3. **Wizard tests**:
   - Run wizard with mocked stdin, verify config written correctly
   - Skip provider -> config has empty apiKeys entry
   - Invalid input handling

4. **Update tests**:
   - Mock GitHub API with older/newer versions
   - `performSelfUpdate` atomic replace works

## Dependencies

- **Depends on:** Spec 10 (Non-interactive mode — needed for CI/Docker), Spec 13 (Error Recovery — auto-update fallbacks)
- **Depended on by:** Spec 17 (Documentation — installation section points to these channels)
- **External:** GitHub Actions for CI/CD, GitHub Releases for artifacts, Homebrew tap repo, npm registry, GitHub Container Registry

## Estimated Effort

**2.5 days** (revised from 6 days)
- Day 1: esbuild bundling for backend.js, npm package + postinstall TUI download, GitHub Actions build matrix for tarballs.
- Day 2: Homebrew formula + tap repo, Dockerfile + GHCR publish.
- Day 2.5: First-run wizard (`src/cli/wizard.ts`) and inline update banner.
