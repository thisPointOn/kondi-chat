/**
 * Structured error hierarchy for the agent engine.
 *
 * All domain-specific failure modes should inherit from `KondiError`
 * rather than throw bare `Error` instances, so the backend and TUI can
 * make informed decisions about how to surface a failure to the user
 * (retry vs. give up vs. abort the turn).
 *
 * Design principles:
 *   - Every error carries a `severity` so callers can distinguish
 *     recoverable ("retry with different args") from fatal ("the
 *     pipeline cannot continue").
 *   - Every error carries a `stage` string so log messages and ledger
 *     entries can attribute the failure to the specific step that broke.
 *   - Errors are plain `Error` subclasses so they work with existing
 *     stack-trace tooling and Node's `instanceof` checks.
 *
 * This file is deliberately tiny — the goal is to stop swallowing errors
 * at the pipeline layer, not to refactor every throw site in the
 * codebase in one pass.
 */

/** Coarse severity ladder for structured failures. */
export type ErrorSeverity =
  | 'info'          // informational — the caller can ignore this
  | 'warning'       // worth logging but not worth aborting for
  | 'recoverable'   // retry with different args may succeed
  | 'fatal';        // the enclosing operation cannot continue

/**
 * Base class for every structured engine error. Plain Errors are still
 * valid throws — they just get treated as 'fatal' when a PipelineError
 * isn't thrown.
 */
export class KondiError extends Error {
  readonly severity: ErrorSeverity;
  readonly stage: string;
  readonly cause?: unknown;

  constructor(message: string, opts: { severity: ErrorSeverity; stage: string; cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.severity = opts.severity;
    this.stage = opts.stage;
    this.cause = opts.cause;
  }
}

/**
 * Thrown from within `runPipeline` when a stage cannot complete. Carries
 * the stage name (`dispatch`/`execute`/`apply`/`verify`/`reflect`) so
 * downstream error handlers can surface a meaningful location.
 */
export class PipelineError extends KondiError {
  constructor(
    message: string,
    opts: { severity: ErrorSeverity; stage: 'dispatch' | 'execute' | 'apply' | 'verify' | 'reflect'; cause?: unknown },
  ) {
    super(message, opts);
  }
}

/**
 * Thrown from tool executors on structured tool failures (not every
 * tool error — routine "file not found" still returns `{ isError: true }`).
 * Reserved for failures that should surface as errors rather than as
 * tool-result content the model can read and react to.
 */
export class ToolError extends KondiError {
  readonly toolName: string;
  constructor(message: string, opts: { severity: ErrorSeverity; toolName: string; cause?: unknown }) {
    super(message, { severity: opts.severity, stage: `tool:${opts.toolName}`, cause: opts.cause });
    this.toolName = opts.toolName;
  }
}

/** Thrown by LLM provider calls when the request fails definitively. */
export class LlmCallError extends KondiError {
  readonly provider: string;
  readonly model: string;
  readonly status?: number;
  constructor(
    message: string,
    opts: { severity: ErrorSeverity; provider: string; model: string; status?: number; cause?: unknown },
  ) {
    super(message, { severity: opts.severity, stage: `llm:${opts.provider}/${opts.model}`, cause: opts.cause });
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
  }
}

/**
 * Helper: turn an unknown thrown value into a KondiError. Use when
 * wrapping code that may throw bare Errors — the result is always a
 * KondiError subclass so downstream `instanceof` checks are reliable.
 */
export function asKondiError(e: unknown, fallbackStage: string): KondiError {
  if (e instanceof KondiError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new KondiError(message, { severity: 'fatal', stage: fallbackStage, cause: e });
}
