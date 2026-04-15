/**
 * Consultants — domain-expert personas the agent can call on demand.
 *
 * A consultant is a triple of (model, system prompt, optional context
 * strategy). The agent decides when to ask for help and passes a
 * specific question; the consultant's response comes back through the
 * normal tool-call channel. Because consultants are configured in a JSON
 * file, users can add new experts without touching TypeScript.
 *
 * Consultants are deliberately stateless and pure text-in/text-out — they
 * do NOT have access to the main agent's tool set, memory, or session.
 * If you need a consultant that can read files or run commands, spawn a
 * sub-agent via `spawn_agent` instead; that path is heavier but fully
 * agentic. Consultants are for opinion, not for execution.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProviderId } from '../types.ts';
import type { Ledger } from '../audit/ledger.ts';
import { callLLM } from '../providers/llm-caller.ts';
import type { ToolExecutionResult } from './tools.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Consultant {
  /** Short machine identifier used in the `consult` tool call. */
  role: string;
  /** Human-readable name shown in listings. */
  name: string;
  /**
   * One-line description of when the agent should consult this expert.
   * Surfaced to the agent so it can decide whether a given problem warrants
   * this particular perspective.
   */
  description: string;
  /** Provider + model that runs this persona. */
  provider: ProviderId;
  model: string;
  /**
   * The full system prompt that defines the persona. This is where the
   * expertise actually lives — the choice of model is secondary to a
   * well-written system prompt describing priorities, vocabulary, and
   * what to flag.
   */
  system: string;
  /** Soft cap on output tokens for this consultant. Default 2048. */
  maxOutputTokens?: number;
  /**
   * Static text that should be included in this consultant's context on
   * every call. Good for: project-specific constraints the consultant
   * should always know ("target DO-178C DAL-B", "monorepo of 40k LOC
   * TypeScript", etc.), vocabulary, stable decisions. Appended to the
   * system prompt so it benefits from provider-side prompt caching.
   */
  contextText?: string;
  /**
   * Files to read from the working directory on every consultation and
   * inject as context. Paths are relative to the working dir. Each file
   * is capped at `contextFileMaxBytes` (default 50 KB) to prevent a
   * stray large file from blowing the prompt budget; the total load is
   * capped at `contextTotalMaxBytes` (default 200 KB).
   *
   * Use for slow-changing reference material like specs, design docs,
   * or the README. Do NOT use for active source files the agent is
   * editing — that path belongs in the per-call `context` argument so
   * the consultant sees the current state, not a stale snapshot.
   */
  contextFiles?: string[];
  /** Per-file byte cap (default 50_000). */
  contextFileMaxBytes?: number;
  /** Total context byte cap across all contextFiles (default 200_000). */
  contextTotalMaxBytes?: number;
}

// ---------------------------------------------------------------------------
// Default roster — created on first run so the file exists to edit
// ---------------------------------------------------------------------------

const DEFAULT_CONSULTANTS: Consultant[] = [
  {
    role: 'aerospace-engineer',
    name: 'Senior Aerospace Engineer',
    description:
      'Review designs and implementations for flight-safety, fault tolerance, margins, ' +
      'redundancy, and certification implications. Use for avionics, flight control, ' +
      'propulsion, actuation, or any safety-critical embedded code.',
    provider: 'openai',
    model: 'gpt-5.4',
    system:
      'You are a senior aerospace engineer with 30 years of experience across avionics, ' +
      'flight control software, propulsion control, and safety-critical embedded systems. ' +
      'When reviewing a design or implementation, think explicitly about: failure modes ' +
      '(FMEA), single points of failure, margins (timing, current, thermal, structural), ' +
      'redundancy and voting, fault containment, fail-operational vs fail-safe behavior, ' +
      'flight envelope, bus loading and real-time scheduling, certification implications ' +
      '(DO-178C DAL, DO-254), and what the pilot sees when it breaks. Be blunt about risks. ' +
      'If the question is outside your domain, say so explicitly rather than guess. ' +
      'Output: numbered concerns in priority order, each with severity (LOW/MED/HIGH/BLOCKING) ' +
      'and a concrete mitigation.',
    maxOutputTokens: 2048,
    // Example of persistent context — commented out because these paths
    // likely don't exist in your project. Edit consultants.json to point
    // at real spec files once you have them:
    //
    //   "contextText": "Target platform: ARM Cortex-R52 triple-core lockstep. DO-178C DAL-B.",
    //   "contextFiles": ["specs/fmea.md", "specs/safety-case.md"]
  },
  {
    role: 'security-auditor',
    name: 'Application Security Auditor',
    description:
      'Review code for security vulnerabilities: OWASP top-10, authn/authz, input validation, ' +
      'secrets handling, injection, SSRF, crypto misuse, race conditions, supply-chain risks. ' +
      'Use when touching auth flows, user input, cryptography, file I/O, or network requests.',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    system:
      'You are an application security auditor with a red-team background. Review the ' +
      'supplied code or design against: OWASP top-10, authentication and authorization ' +
      'flows, input validation and parser differentials, injection (SQL, command, path, ' +
      'template), SSRF and DNS rebinding, cryptography misuse and weak randomness, secrets ' +
      'handling, TOCTOU and race conditions, deserialization risks, dependency/supply-chain ' +
      'integrity, and denial-of-service surface. Be specific about exploit scenarios. ' +
      'Output: numbered findings in severity order (INFO/LOW/MED/HIGH/CRITICAL), each with ' +
      'a one-line attack description and a concrete remediation.',
    maxOutputTokens: 2048,
  },
  {
    role: 'database-architect',
    name: 'Database Architect',
    description:
      'Review schemas, queries, migrations, and data access patterns. Use for questions ' +
      'about indexes, transaction isolation, migration safety on large tables, query plans, ' +
      'normalization trade-offs, partitioning, or OLTP-vs-OLAP boundaries.',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    system:
      'You are a database architect fluent in Postgres, MySQL, SQLite, and general RDBMS ' +
      'theory. When reviewing a schema, query, or migration, think about: index coverage, ' +
      'query plan stability, lock scope and duration, isolation levels and phantom reads, ' +
      'migration safety on large tables (NOT NULL backfills, column drops, type changes), ' +
      'transaction semantics, normalization vs denormalization trade-offs, JSON/JSONB usage, ' +
      'partitioning, read-replica consistency, and OLTP/OLAP mixing. Point out anti-patterns ' +
      'directly. Output: numbered concerns by severity, each with a concrete fix.',
    maxOutputTokens: 2048,
  },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load consultants from `<storageDir>/consultants.json`. If the file
 * doesn't exist, seed it with the default roster so users have a
 * starting point to edit.
 */
export function loadConsultants(storageDir: string): Consultant[] {
  const path = join(storageDir, 'consultants.json');
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(DEFAULT_CONSULTANTS, null, 2));
    } catch {
      /* non-fatal — fall back to in-memory defaults */
    }
    return [...DEFAULT_CONSULTANTS];
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(raw)) return [...DEFAULT_CONSULTANTS];
    return raw.filter(
      (c): c is Consultant =>
        typeof c?.role === 'string' &&
        typeof c?.name === 'string' &&
        typeof c?.provider === 'string' &&
        typeof c?.model === 'string' &&
        typeof c?.system === 'string',
    );
  } catch {
    return [...DEFAULT_CONSULTANTS];
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run the `consult` tool. Three behaviors based on `args`:
 *
 *   1. No `role` provided → return a roster listing so the agent can
 *      decide who to ask next. Pure discovery call, cheap.
 *   2. Unknown `role` → return an error listing the valid roles.
 *   3. Valid `role` + `question` → invoke the consultant's LLM with the
 *      system prompt from the JSON, return the response as tool content.
 *
 * Consultation is logged to the ledger as `phase: 'consult'` with the
 * consultant's role in the promptSummary so `/routing` and `/cost` can
 * attribute the spend.
 */
export async function executeConsult(
  args: Record<string, unknown>,
  consultants: Consultant[],
  ledger: Ledger,
  workingDir: string,
): Promise<ToolExecutionResult> {
  const role = typeof args.role === 'string' ? args.role.trim() : '';
  const question = typeof args.question === 'string' ? args.question : '';
  const callerContext = typeof args.context === 'string' ? args.context : '';

  if (!role) {
    return { content: formatRoster(consultants) };
  }

  const consultant = consultants.find(c => c.role === role);
  if (!consultant) {
    return {
      content:
        `Unknown consultant role: ${role}\n\n` +
        `Available roles:\n${consultants.map(c => `  - ${c.role} — ${c.description}`).join('\n')}`,
      isError: true,
    };
  }

  if (!question) {
    return {
      content: `consult requires a "question" when a role is specified. You asked for ${consultant.name} but didn't pass a question.`,
      isError: true,
    };
  }

  // Assemble the persistent context block (contextText + contextFiles).
  // Failures loading a file are reported inline so the consultant — and
  // the orchestrating agent — can see that a reference is missing, but
  // they do not abort the call.
  const persistent = assemblePersistentContext(consultant, workingDir);
  const systemPrompt = persistent
    ? `${consultant.system}\n\n--- Project reference (persistent) ---\n${persistent}`
    : consultant.system;

  const userMessage = callerContext
    ? `${question}\n\n--- Context from caller ---\n${callerContext}`
    : question;

  try {
    const response = await callLLM({
      provider: consultant.provider,
      model: consultant.model,
      systemPrompt,
      userMessage,
      maxOutputTokens: consultant.maxOutputTokens ?? 2048,
      temperature: 0.2,
    });
    ledger.record(
      'consult',
      response,
      `consult ${consultant.role}: ${question.slice(0, 160)}`,
    );
    return {
      content:
        `[${consultant.name} · ${response.model}]\n\n${response.content || '(no response)'}`,
    };
  } catch (error) {
    return {
      content: `Consultation with ${consultant.role} failed: ${(error as Error).message}`,
      isError: true,
    };
  }
}

/**
 * Build the persistent-context block from `contextText` + `contextFiles`.
 * Files are resolved against `workingDir`, byte-capped per file and in
 * total, and path-escape-protected so a consultant config can't read
 * arbitrary paths outside the project by setting `"../../etc/passwd"`.
 */
function assemblePersistentContext(consultant: Consultant, workingDir: string): string {
  const perFileCap = consultant.contextFileMaxBytes ?? 50_000;
  const totalCap = consultant.contextTotalMaxBytes ?? 200_000;

  const parts: string[] = [];
  if (consultant.contextText && consultant.contextText.trim().length > 0) {
    parts.push(consultant.contextText.trim());
  }

  if (consultant.contextFiles && consultant.contextFiles.length > 0) {
    const base = resolve(workingDir);
    let remaining = totalCap;
    for (const relOrAbs of consultant.contextFiles) {
      if (remaining <= 0) {
        parts.push(`[context file skipped — total cap ${totalCap} bytes reached]`);
        break;
      }
      const abs = isAbsolute(relOrAbs) ? resolve(relOrAbs) : resolve(base, relOrAbs);
      if (!abs.startsWith(base)) {
        parts.push(`[context file rejected — outside working dir: ${relOrAbs}]`);
        continue;
      }
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) {
          parts.push(`[context file not a regular file: ${relOrAbs}]`);
          continue;
        }
        const cap = Math.min(perFileCap, remaining);
        const raw = readFileSync(abs, 'utf-8');
        const clipped = raw.length > cap
          ? raw.slice(0, cap) + `\n[...truncated from ${raw.length} to ${cap} bytes]`
          : raw;
        remaining -= clipped.length;
        parts.push(`# ${relOrAbs}\n${clipped}`);
      } catch (e) {
        parts.push(`[context file load failed: ${relOrAbs} — ${(e as Error).message}]`);
      }
    }
  }

  return parts.join('\n\n');
}

function formatRoster(consultants: Consultant[]): string {
  if (consultants.length === 0) {
    return 'No consultants configured. Edit .kondi-chat/consultants.json to add some.';
  }
  const lines: string[] = ['Available consultants:', ''];
  for (const c of consultants) {
    lines.push(`  ${c.role}`);
    lines.push(`    ${c.name} (${c.provider}/${c.model})`);
    lines.push(`    ${c.description}`);
    if (c.contextText) {
      const preview = c.contextText.trim().replace(/\s+/g, ' ');
      lines.push(`    baseline: ${preview.length > 120 ? preview.slice(0, 117) + '…' : preview}`);
    }
    if (c.contextFiles && c.contextFiles.length > 0) {
      lines.push(`    attached files: ${c.contextFiles.join(', ')}`);
    }
    lines.push('');
  }
  lines.push(
    'Call consult({role: "<role>", question: "<your question>", context?: "<optional file or design snippet>"}) to ask one.',
  );
  return lines.join('\n');
}
