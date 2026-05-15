/**
 * Pipeline Executor
 * Runs pipelines: sequential stages, parallel steps within stages.
 * Council steps (planning, coding, decisioning, execution, etc.) create councils.
 * Script steps run shell commands. Condition steps evaluate expressions.
 * Gate steps pause for user approval.
 */

import type {
  Pipeline,
  PipelineStage,
  PipelineStep,
  StepArtifact,
  StepMeta,
  RunManifest,
  CouncilStepConfig,
  LlmStepConfig,
  GateStepConfig,
  ScriptStepConfig,
  ConditionStepConfig,
} from './types';
import { migrateLlmConfig } from './types';

import { pipelineStore } from './store';
import { councilStore } from '../council/store';
import { createCouncilFromSetup } from '../council/factory';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import { CodingOrchestrator } from '../council/coding-orchestrator';
import { getDecision, getLatestOutput } from '../council/context-store';
import { stripCompletedCouncil } from '../council/storage-cleanup';
import { buildAbbreviatedSummary } from '../services/deliberationSummary';
import type { Persona } from '../council/types';
import type { AgentInvocation, AgentResponse } from '../council/deliberation-orchestrator';
import type { MCPTool } from '../types/mcp';
import { verifyRequiredTools } from '../utils/filterTools';

import type { MemoryContext } from './memory-store';
import { buildMemoryContext, appendEntry, getNextRunNumber } from './memory-store';
import { sanitizeFolderName } from './run-output';
import {
  buildRunDirName,
  getRunsBaseDir,
  buildStepOutputDir,
  writeStepOutput,
  writeRunManifest,
  pruneOldRuns,
} from './run-output';

// ============================================================================
// Callback Types
// ============================================================================

export interface PipelineExecutorCallbacks {
  /** Same invokeAgent used by DeliberationOrchestrator */
  invokeAgent: (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;

  /** Returns all currently available MCP tools (for pre-flight tool checks) */
  getAvailableTools?: () => Map<string, { serverId: string; tools: MCPTool[] }>;

  onStageStart?: (stageIndex: number) => void;
  onStageComplete?: (stageIndex: number) => void;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, artifact: StepArtifact) => void;
  onStepError?: (stepId: string, error: string) => void;
  onGateWaiting?: (stepId: string, prompt: string) => Promise<boolean>;
  onCouncilCreated?: (stepId: string, councilId: string) => void;
  onAgentThinkingStart?: (persona: Persona, startedAt: number, prompt?: string) => void;
  onAgentThinkingEnd?: (persona: Persona) => void;
}

// ============================================================================
// Platform Adapter (abstracts Tauri / Node.js)
// ============================================================================

export interface PlatformAdapter {
  writeFile(path: string, content: string): Promise<void>;
  readFile?(path: string): Promise<string | null>;
  runCommand?(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;
  setWorkingDir(dir: string): void;
  getWorkingDir(): string;
  saveDeliberationOutput?(council: any, mode: 'full' | 'abbreviated'): Promise<string>;
}

// ============================================================================
// Input Template Rendering
// ============================================================================

/**
 * Prepend a provenance header so downstream steps know what produced the content.
 * Skip header for synthetic initial-input artifacts (stepId === '__initial__').
 */
function formatArtifactForInput(artifact: StepArtifact): string {
  if (artifact.stepId === '__initial__') {
    return artifact.content;
  }

  const lines: string[] = [];
  if (artifact.metadata?.stepName) {
    const typeLabel = artifact.metadata.stepType ? ` (${artifact.metadata.stepType})` : '';
    lines.push(`[Source: ${artifact.metadata.stepName}${typeLabel}]`);
  }

  const outputType = artifact.metadata?.outputType || 'string';
  const outputPath = artifact.metadata?.outputPath;

  if (outputType === 'json') {
    lines.push(`[Output type: json]`);
  } else if (outputType === 'directory' && outputPath) {
    lines.push(`[Output type: directory]`);
    lines.push(`[Output directory: ${outputPath}]`);
    lines.push(`IMPORTANT: The previous step produced output in the directory above. Use your tools to list and read the files in that directory to understand the full context of what was produced.`);
  } else if (outputType === 'file' && outputPath) {
    lines.push(`[Output type: file]`);
    lines.push(`[Output file: ${outputPath}]`);
    lines.push(`IMPORTANT: The previous step produced output in the file above. Use your tools to read that file to understand the full context of what was produced.`);
  } else if (outputPath) {
    lines.push(`[Output file: ${outputPath}]`);
  }

  if (lines.length > 0) {
    return lines.join('\n') + '\n\n' + artifact.content;
  }
  return artifact.content;
}

/**
 * Parse artifact content as JSON and walk a dot-separated path.
 * Returns the stringified value at the path, or '' if parsing fails or path not found.
 */
function resolveJsonPath(content: string, dotPath: string): string {
  try {
    let obj = JSON.parse(content);
    for (const key of dotPath.split('.')) {
      if (obj == null || typeof obj !== 'object') return '';
      obj = obj[key];
    }
    if (obj === undefined || obj === null) return '';
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch {
    return '';
  }
}

function renderInputTemplate(
  template: string,
  previousArtifacts: StepArtifact[],
  memoryCtx?: MemoryContext
): string {
  // "none" means no input from previous steps — step only sees its task
  if (template === 'none') return '';

  if (!template || template === '{{input}}') {
    return previousArtifacts.map((a) => formatArtifactForInput(a)).join('\n\n---\n\n');
  }

  let result = template;

  // Replace {{input}} with all artifacts joined (with provenance headers)
  result = result.replace(
    /\{\{input\}\}/g,
    previousArtifacts.map((a) => formatArtifactForInput(a)).join('\n\n---\n\n')
  );

  // Replace {{input[N]}} with specific artifact (with provenance header)
  result = result.replace(/\{\{input\[(\d+)\]\}\}/g, (_match, index) => {
    const i = parseInt(index, 10);
    return previousArtifacts[i] ? formatArtifactForInput(previousArtifacts[i]) : '';
  });

  // Replace {{file}} with all output file paths (newline-joined, non-null only)
  result = result.replace(
    /\{\{file\}\}/g,
    previousArtifacts
      .map((a) => a.metadata?.outputPath)
      .filter(Boolean)
      .join('\n')
  );

  // Replace {{file[N]}} with specific artifact's file path
  result = result.replace(/\{\{file\[(\d+)\]\}\}/g, (_match, index) => {
    const i = parseInt(index, 10);
    return previousArtifacts[i]?.metadata?.outputPath || '';
  });

  // Replace {{input.fieldName}} with JSON field from last artifact (dot-path walk)
  result = result.replace(/\{\{input\.([a-zA-Z0-9_.]+)\}\}/g, (_match, path) => {
    const last = previousArtifacts[previousArtifacts.length - 1];
    if (!last) return '';
    return resolveJsonPath(last.content, path);
  });

  // Replace {{input[N].fieldName}} with JSON field from specific artifact
  result = result.replace(/\{\{input\[(\d+)\]\.([a-zA-Z0-9_.]+)\}\}/g, (_match, index, path) => {
    const i = parseInt(index, 10);
    if (!previousArtifacts[i]) return '';
    return resolveJsonPath(previousArtifacts[i].content, path);
  });

  // ---- Memory template variables ----
  if (memoryCtx) {
    // {{memory}} — all entries
    result = result.replace(/\{\{memory\}\}/g, memoryCtx.all);

    // {{memory.last_n(N)}} — last N entries (must be before {{memory.last.X}})
    result = result.replace(/\{\{memory\.last_n\((\d+)\)\}\}/g, (_match, n) => {
      return memoryCtx.lastN(parseInt(n, 10));
    });

    // {{memory.last.step_name}} — specific capture from last entry
    result = result.replace(/\{\{memory\.last\.([a-zA-Z0-9_]+)\}\}/g, (_match, stepName) => {
      return memoryCtx.lastCapture(stepName);
    });

    // {{memory.last}} — most recent entry
    result = result.replace(/\{\{memory\.last\}\}/g, memoryCtx.last);

    // {{memory.patterns}} — compressed pattern summaries
    result = result.replace(/\{\{memory\.patterns\}\}/g, memoryCtx.patterns);
  } else {
    // No memory — resolve all memory templates to empty string
    result = result.replace(/\{\{memory(?:\.[a-zA-Z0-9_()]+)*\}\}/g, '');
  }

  return result;
}

// ============================================================================
// Pipeline Executor
// ============================================================================

export class PipelineExecutor {
  private callbacks: PipelineExecutorCallbacks;
  private platform: PlatformAdapter;
  private aborted = false;
  private runningPipelineId: string | null = null;
  /** Set by condition steps to skip the next stage */
  private skipNextStage = false;
  /** Set by condition steps to stop the pipeline (completes, not fails) */
  private stopPipeline = false;
  /** Memory context loaded at pipeline start (if maintainMemory is enabled) */
  private memoryCtx: MemoryContext | undefined = undefined;
  /** Current run directory for output isolation */
  private currentRunDir: string | null = null;
  /** Current run number */
  private currentRunNumber = 0;
  /** Pipeline start timestamp */
  private runStartedAt: string | null = null;

  constructor(callbacks: PipelineExecutorCallbacks, platform: PlatformAdapter) {
    this.callbacks = callbacks;
    this.platform = platform;
  }

  /**
   * Run a pipeline from its current stage index.
   * Supports resume — skips completed stages.
   */
  async run(pipelineId: string): Promise<void> {
    const pipeline = pipelineStore.get(pipelineId);
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

    if (pipeline.stages.length === 0) {
      throw new Error('Pipeline has no stages');
    }

    this.aborted = false;
    this.skipNextStage = false;
    this.stopPipeline = false;
    this.runningPipelineId = pipelineId;
    this.memoryCtx = undefined;
    this.currentRunDir = null;
    this.currentRunNumber = 0;
    this.runStartedAt = new Date().toISOString();
    pipelineStore.setPipelineStatus(pipelineId, 'running');

    const workingDir = pipeline.settings.workingDirectory;

    // Load memory context if maintainMemory is enabled
    if (workingDir && pipeline.settings.schedule?.maintainMemory) {
      try {
        this.memoryCtx = await buildMemoryContext(this.platform, workingDir, pipelineId);
        console.log('[PipelineExecutor] Loaded memory context for pipeline');
      } catch (err) {
        console.warn('[PipelineExecutor] Failed to load memory context:', err);
      }
    }

    // Set up run output directory
    const outputConfig = pipeline.settings.outputConfig;
    if (workingDir && outputConfig?.enabled !== false) {
      try {
        this.currentRunNumber = await getNextRunNumber(this.platform, workingDir, pipelineId);
        const runDirName = buildRunDirName(pipeline.name, this.currentRunNumber, new Date());
        const runsBase = getRunsBaseDir(workingDir);
        this.currentRunDir = `${runsBase}/${runDirName}`;
        console.log(`[PipelineExecutor] Run output dir: ${this.currentRunDir}`);
      } catch (err) {
        console.warn('[PipelineExecutor] Failed to set up run directory:', err);
      }
    }

    try {
      for (let i = pipeline.currentStageIndex; i < pipeline.stages.length; i++) {
        if (this.aborted) {
          return; // status already set by abort()
        }

        // Refresh pipeline state
        const current = pipelineStore.get(pipelineId);
        if (!current) throw new Error('Pipeline disappeared');

        const stage = current.stages[i];

        // Skip completed stages (for resume)
        if (stage.steps.every((s) => s.status === 'completed' || s.status === 'skipped')) {
          continue;
        }

        // Check if a condition step requested skipping this stage
        if (this.skipNextStage) {
          this.skipNextStage = false;
          // Mark all steps in this stage as skipped
          for (const step of stage.steps) {
            if (step.status !== 'completed' && step.status !== 'skipped') {
              pipelineStore.setStepStatus(pipelineId, step.id, 'skipped');
            }
          }
          pipelineStore.advanceStage(pipelineId);
          continue;
        }

        // Collect previous stage artifacts (or initial input for stage 0)
        const previousArtifacts = this.collectPreviousArtifacts(current, i);

        this.callbacks.onStageStart?.(i);

        // Run all steps in this stage
        await this.runStage(pipelineId, stage, previousArtifacts, current.settings.failurePolicy, current.settings);

        // Check abort again after stage completes (don't advance if aborted)
        if (this.aborted) {
          return;
        }

        this.callbacks.onStageComplete?.(i);

        // Advance stage index
        pipelineStore.advanceStage(pipelineId);

        // Check if a condition step requested stopping after this stage
        if (this.stopPipeline) {
          // Skip remaining stages
          const updated = pipelineStore.get(pipelineId);
          if (updated) {
            for (let j = i + 1; j < updated.stages.length; j++) {
              for (const step of updated.stages[j].steps) {
                if (step.status === 'pending') {
                  pipelineStore.setStepStatus(pipelineId, step.id, 'skipped');
                }
              }
            }
          }
          break;
        }
      }

      if (!this.aborted) {
        pipelineStore.setPipelineStatus(pipelineId, 'completed');

        // Post-completion: capture memory and write run manifest
        const completedPipeline = pipelineStore.get(pipelineId);
        let memoryUpdated = false;

        if (completedPipeline) {
          // Capture memory if enabled
          if (workingDir && completedPipeline.settings.schedule?.maintainMemory) {
            try {
              await this.captureMemory(completedPipeline, workingDir);
              memoryUpdated = true;
              console.log('[PipelineExecutor] Memory entry captured');
            } catch (err) {
              console.warn('[PipelineExecutor] Failed to capture memory:', err);
            }
          }

          // Write run manifest
          if (this.currentRunDir) {
            try {
              await this.writeManifest(completedPipeline, 'completed', memoryUpdated);
            } catch (err) {
              console.warn('[PipelineExecutor] Failed to write run manifest:', err);
            }
          }

          // Prune old runs
          const maxRetained = completedPipeline.settings.outputConfig?.maxRetainedRuns;
          if (workingDir && maxRetained && maxRetained > 0) {
            try {
              const runsBase = getRunsBaseDir(workingDir);
              await pruneOldRuns(this.platform, runsBase, completedPipeline.name, maxRetained);
            } catch (err) {
              console.warn('[PipelineExecutor] Failed to prune old runs:', err);
            }
          }
        }
      }
    } catch (error) {
      if (this.aborted) return; // don't overwrite 'paused' status on abort
      const message = error instanceof Error ? error.message : String(error);
      console.error('[PipelineExecutor] Pipeline failed:', message);
      pipelineStore.setPipelineStatus(pipelineId, 'failed');

      // Write failed manifest if we have a run directory
      if (this.currentRunDir) {
        const failedPipeline = pipelineStore.get(pipelineId);
        if (failedPipeline) {
          try {
            await this.writeManifest(failedPipeline, 'failed', false);
          } catch { /* best effort */ }
        }
      }

      throw error;
    } finally {
      this.runningPipelineId = null;
      this.memoryCtx = undefined;
      this.currentRunDir = null;
    }
  }

  /**
   * Abort a running pipeline. Sets status to 'paused' immediately and marks
   * any currently-running steps as failed so the UI updates right away.
   */
  abort(): void {
    this.aborted = true;
    if (this.runningPipelineId) {
      const pipeline = pipelineStore.get(this.runningPipelineId);
      if (pipeline) {
        // Mark any running steps as failed
        for (const stage of pipeline.stages) {
          for (const step of stage.steps) {
            if (step.status === 'running') {
              pipelineStore.setStepStatus(this.runningPipelineId, step.id, 'failed', 'Aborted by user');
            }
          }
        }
        pipelineStore.setPipelineStatus(this.runningPipelineId, 'failed');
      }
    }
  }

  // --------------------------------------------------------------------------
  // Stage Execution
  // --------------------------------------------------------------------------

  private collectPreviousArtifacts(
    pipeline: Pipeline,
    currentStageIndex: number
  ): StepArtifact[] {
    if (currentStageIndex === 0) {
      // For stage 0, create a synthetic artifact from initialInput
      if (!pipeline.initialInput) return [];
      return [
        {
          stepId: '__initial__',
          content: pipeline.initialInput,
          artifactType: 'output',
          createdAt: new Date().toISOString(),
        },
      ];
    }

    const previousStage = pipeline.stages[currentStageIndex - 1];
    return previousStage.steps
      .filter((s) => s.artifact)
      .map((s) => s.artifact!);
  }

  private async runStage(
    pipelineId: string,
    stage: PipelineStage,
    previousArtifacts: StepArtifact[],
    failurePolicy: 'stop' | 'skip_step',
    pipelineSettings: Pipeline['settings']
  ): Promise<void> {
    const mode = stage.executionMode || 'sequential';

    if (mode === 'parallel') {
      // Run all steps concurrently
      const results = await Promise.allSettled(
        stage.steps.map((step) =>
          this.runStep(pipelineId, step, previousArtifacts, pipelineSettings)
        )
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') {
          const error = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

          if (failurePolicy === 'stop') {
            throw new Error(`Step "${stage.steps[i].name}" failed: ${error}`);
          }
        }
      }
    } else {
      // Run steps one at a time, in order.
      // Accumulate artifacts so later steps can reference earlier steps' outputs.
      const accumulatedArtifacts = [...previousArtifacts];
      for (const step of stage.steps) {
        if (this.aborted || this.stopPipeline) return;

        try {
          await this.runStep(pipelineId, step, accumulatedArtifacts, pipelineSettings);
          // Add completed step's artifact for subsequent steps
          const updated = pipelineStore.get(pipelineId);
          const updatedStep = updated?.stages.flatMap(s => s.steps).find(s => s.id === step.id);
          if (updatedStep?.artifact) {
            accumulatedArtifacts.push(updatedStep.artifact);
          }
        } catch (error) {
          if (failurePolicy === 'stop') {
            throw error;
          }
          // skip_step: already marked as failed in runStep
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Step Dispatch
  // --------------------------------------------------------------------------

  private async runStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[],
    pipelineSettings: Pipeline['settings']
  ): Promise<void> {
    // Skip already completed steps (for resume)
    if (step.status === 'completed' || step.status === 'skipped') return;

    pipelineStore.setStepStatus(pipelineId, step.id, 'running');
    this.callbacks.onStepStart?.(step.id);

    // Per-step context — avoids mutating shared this.callbacks (race-safe for parallel steps)
    const stepCtx = { councilId: null as string | null };

    try {
      let artifact: StepArtifact;

      if (step.config.type === 'gate') {
        artifact = await this.runGateStep(pipelineId, step);
      } else if (step.config.type === 'script') {
        artifact = await this.runScriptStep(pipelineId, step, previousArtifacts);
      } else if (step.config.type === 'condition') {
        artifact = await this.runConditionStep(pipelineId, step, previousArtifacts);
      } else {
        // Convert LLM steps (decisioning/execution) to lightweight council configs
        const councilStep = this.normalizeToCouncilStep(step);
        artifact = await this.runCouncilStep(pipelineId, councilStep, previousArtifacts, pipelineSettings, stepCtx);
      }

      pipelineStore.setStepArtifact(pipelineId, step.id, artifact);
      pipelineStore.setStepStatus(pipelineId, step.id, 'completed');

      // Write step output to isolated run directory
      if (this.currentRunDir) {
        try {
          const loc = this.findStepLocation(pipelineId, step.id);
          if (loc) {
            const stepDir = buildStepOutputDir(
              this.currentRunDir, loc.stageIndex, loc.stageName, loc.stepIndex, step.name
            );
            const meta: StepMeta = {
              stepId: step.id,
              stepName: step.name,
              stepType: step.config.type,
              stageIndex: loc.stageIndex,
              stepIndex: loc.stepIndex,
              startedAt: step.startedAt,
              completedAt: step.completedAt,
              status: 'completed',
              outputType: (step.config as any).outputType || 'string',
              councilId: artifact.metadata?.councilId,
              model: artifact.metadata?.model,
              tokensUsed: artifact.metadata?.tokensUsed,
            };
            const outputPath = await writeStepOutput(this.platform, stepDir, artifact, meta);
            console.log(`[PipelineExecutor] Step output: ${outputPath}`);
            // Update artifact metadata to point to the isolated output file
            artifact.metadata = { ...artifact.metadata, outputPath };
            pipelineStore.setStepArtifact(pipelineId, step.id, artifact);
          }
        } catch (err) {
          console.warn('[PipelineExecutor] Failed to write step output:', err);
        }
      }

      this.callbacks.onStepComplete?.(step.id, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // For steps that created a council before failing, write a partial
      // artifact so the UI can still link to the deliberation ledger
      if (stepCtx.councilId) {
        pipelineStore.setStepArtifact(pipelineId, step.id, {
          stepId: step.id,
          content: `Step failed: ${message}`,
          artifactType: 'output',
          metadata: { councilId: stepCtx.councilId, stepName: step.name, stepType: step.config.type },
          createdAt: new Date().toISOString(),
        });
      }

      pipelineStore.setStepStatus(pipelineId, step.id, 'failed', message);
      this.callbacks.onStepError?.(step.id, message);
      throw error;
    }
  }

  /**
   * Ensure a step has a CouncilStepConfig.
   * Steps with councilSetup (new format) pass through unchanged.
   * Legacy LlmStepConfig (flat model/provider/systemPrompt) is migrated.
   */
  private normalizeToCouncilStep(step: PipelineStep): PipelineStep {
    const config = step.config;

    // Already a CouncilStepConfig — has councilSetup
    if ('councilSetup' in config) {
      return step;
    }

    // Legacy LlmStepConfig — migrate to CouncilStepConfig
    const migrated = migrateLlmConfig(config as LlmStepConfig);
    return { ...step, config: migrated };
  }

  // --------------------------------------------------------------------------
  // Council Step
  // --------------------------------------------------------------------------

  private async runCouncilStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[],
    pipelineSettings: Pipeline['settings'],
    stepCtx: { councilId: string | null }
  ): Promise<StepArtifact> {
    const config = step.config as CouncilStepConfig;

    // Build the problem: task (instructions) + pipeline input (optional) + input (context from previous steps)
    const inputContext = renderInputTemplate(config.inputTemplate, previousArtifacts, this.memoryCtx);
    const pipelineInput = config.includePipelineInput
      ? pipelineStore.get(pipelineId)?.initialInput || ''
      : '';
    const parts = [config.task, pipelineInput, inputContext].filter(Boolean);
    const rawProblem = parts.join('\n\n---\n\n');

    // Pre-flight: verify MCP tools referenced in step prompts are actually available
    if (this.callbacks.getAvailableTools) {
      const promptText = [
        config.task || '',
        ...config.councilSetup.personas.map(p => p.systemPrompt || ''),
      ].join('\n');
      verifyRequiredTools(this.callbacks.getAvailableTools(), promptText, step.name);
    }

    // Resolve effective working directory with inheritance (default: constrained)
    const isConstrained = pipelineSettings.directoryConstrained !== false;
    const effectiveDir = isConstrained
      ? pipelineSettings.workingDirectory
      : config.councilSetup.workingDirectory || pipelineSettings.workingDirectory;

    // Create council via factory
    const council = createCouncilFromSetup({
      ...config.councilSetup,
      task: config.task,
      topic: rawProblem.slice(0, 200),
      workingDirectory: effectiveDir,
      directoryConstrained: isConstrained,
      saveDeliberation: true,
      saveDeliberationMode: 'full',
      stepType: config.type,
      pipelinePrefix: '[Pipeline]',
      pipelineId: pipelineId,
    });

    stepCtx.councilId = council.id;
    this.callbacks.onCouncilCreated?.(step.id, council.id);

    // Branch: coding steps use CodingOrchestrator, planning uses DeliberationOrchestrator
    const orchestratorCallbacks = {
      invokeAgent: this.callbacks.invokeAgent,
      onPhaseChange: (from: any, to: any) =>
        console.log(`[Pipeline:Council] Phase: ${from} -> ${to}`),
      onError: (err: Error, ctx: string) =>
        console.error(`[Pipeline:Council] Error in ${ctx}:`, err),
      onAgentThinkingStart: this.callbacks.onAgentThinkingStart,
      onAgentThinkingEnd: this.callbacks.onAgentThinkingEnd,
    };

    if (config.type === 'coding') {
      const codingOrchestrator = new CodingOrchestrator({
        ...orchestratorCallbacks,
        runCommand: this.platform.runCommand,
        readFile: this.platform.readFile,
      });
      await codingOrchestrator.runCodingWorkflow(council, rawProblem);
    } else {
      const deliberator = new DeliberationOrchestrator(orchestratorCallbacks);
      await deliberator.runFullDeliberation(council, rawProblem);
    }

    // Generate summary and save to disk (normally done by React useEffect, but
    // pipeline executor doesn't render DeliberationView)
    let workerOutputPath: string | undefined;
    const completedCouncil = councilStore.get(council.id);
    if (completedCouncil) {
      const summary = buildAbbreviatedSummary(completedCouncil);
      councilStore.updateDeliberationState(council.id, { completionSummary: summary });

      // Save deliberation output to working directory
      if (effectiveDir) {
        try {
          if (this.platform.saveDeliberationOutput) {
            const outputDir = await this.platform.saveDeliberationOutput(completedCouncil, 'full');
            console.log(`[Pipeline:Council] Saved deliberation output to: ${outputDir}`);
          }
        } catch (err) {
          console.error('[Pipeline:Council] Failed to save deliberation output:', err);
        }

        // Save worker output to run directory root (if output isolation active)
        // Falls back to working directory if no run directory
        const workerPersona = config.councilSetup.personas.find((p) => p.role === 'worker');
        if (workerPersona && workerPersona.saveOutput !== false) {
          const workerOutput = getLatestOutput(council.id);
          if (workerOutput?.content) {
            try {
              const safeName = config.councilSetup.name
                .toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 50);
              const suffix = config.type === 'coding' ? '_code.md' : config.type === 'review' ? '_review.md' : config.type === 'enrich' ? '_enrichment.md' : config.type === 'code_planning' ? '_plan.md' : '_output.md';
              const outputBase = this.currentRunDir || effectiveDir.replace(/\/$/, '');
              workerOutputPath = `${outputBase}/${safeName}${suffix}`;
              await this.platform.writeFile(workerOutputPath, workerOutput.content);
              console.log(`[Pipeline:Council] Saved worker output to: ${workerOutputPath}`);
            } catch (err) {
              console.error('[Pipeline:Council] Failed to save worker output:', err);
            }
          }
        }
      }
    }

    // Extract artifact — decisioning steps use the decision, all others use worker output
    const updatedCouncil = councilStore.get(council.id);
    let content = '';
    let artifactType: StepArtifact['artifactType'] = 'output';
    const metadata: StepArtifact['metadata'] = {
      councilId: council.id,
      outputPath: workerOutputPath,
      outputType: config.outputType || 'string',
      stepName: step.name,
      stepType: config.type,
    };

    if (config.type === 'analysis') {
      const decision = getDecision(council.id);
      if (decision?.content) {
        content = decision.content;
        artifactType = 'decision';
        metadata.decisionId = decision.id;
      } else {
        // Lightweight analysis goes through runDirectExecution → worker output
        const output = getLatestOutput(council.id);
        content = output?.content || 'No decision or output was produced.';
        artifactType = 'output';
        metadata.outputId = output?.id;
      }
    } else {
      const output = getLatestOutput(council.id);
      content = output?.content || 'No output was produced.';
      artifactType = 'output';
      metadata.outputId = output?.id;
    }

    // Strip the localStorage copy of this council's metadata to keep
    // the mcp-councils key small.  The authoritative council data
    // (ledger, context, decision, etc.) remains in the in-memory
    // CouncilDataStore, so it stays accessible for the rest of this session.
    try {
      stripCompletedCouncil(council.id);
    } catch (err) {
      console.warn('[Pipeline] Non-fatal: failed to strip council localStorage copy:', err);
    }

    return {
      stepId: step.id,
      content,
      artifactType,
      metadata,
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Script Step
  // --------------------------------------------------------------------------

  private async runScriptStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[]
  ): Promise<StepArtifact> {
    const config = step.config as ScriptStepConfig;

    if (!this.platform.runCommand) {
      throw new Error('Script steps require a platform with runCommand support');
    }

    if (!config.command.trim()) {
      throw new Error('Script step has no command configured');
    }

    // Render input from previous steps and export as $KONDI_INPUT env var.
    // The input is shell-escaped and passed via env var to avoid injection.
    const stepInput = renderInputTemplate(config.inputTemplate, previousArtifacts, this.memoryCtx);
    const pipelineInput = config.includePipelineInput
      ? pipelineStore.get(pipelineId)?.initialInput || ''
      : '';
    const inputContext = [pipelineInput, stepInput].filter(Boolean).join('\n\n---\n\n');
    const escaped = inputContext.replace(/'/g, "'\\''");
    const command = `export KONDI_INPUT='${escaped}'\n${config.command}`;

    const cwd = this.platform.getWorkingDir();
    const result = await this.platform.runCommand(command, cwd);

    if (!result.success) {
      const errorDetail = result.stderr || result.stdout || `exit code ${result.exit_code}`;
      throw new Error(`Script failed: ${errorDetail}`);
    }

    return {
      stepId: step.id,
      content: result.stdout,
      artifactType: 'output',
      metadata: {
        stepName: step.name,
        stepType: 'script',
        outputType: config.outputType || 'string',
      },
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Condition Step
  // --------------------------------------------------------------------------

  private async runConditionStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[]
  ): Promise<StepArtifact> {
    const config = step.config as ConditionStepConfig;

    if (!config.expression) {
      throw new Error('Condition step has no expression configured');
    }

    const stepInput = renderInputTemplate(config.inputTemplate, previousArtifacts, this.memoryCtx);
    const pipelineInput = config.includePipelineInput
      ? pipelineStore.get(pipelineId)?.initialInput || ''
      : '';
    const inputContext = [pipelineInput, stepInput].filter(Boolean).join('\n\n---\n\n');

    // Evaluate the condition
    let matches = false;
    switch (config.mode) {
      case 'contains':
        matches = inputContext.includes(config.expression);
        break;
      case 'equals':
        matches = inputContext.trim() === config.expression.trim();
        break;
      case 'regex':
        try {
          matches = new RegExp(config.expression).test(inputContext);
        } catch {
          throw new Error(`Invalid regex in condition: ${config.expression}`);
        }
        break;
    }

    const action = matches ? config.trueAction : config.falseAction;
    const resultLabel = matches ? 'TRUE' : 'FALSE';

    // Apply the action
    if (action === 'skip_next_stage') {
      this.skipNextStage = true;
    } else if (action === 'stop') {
      this.stopPipeline = true;
    }

    return {
      stepId: step.id,
      content: `Condition evaluated: ${resultLabel} (mode: ${config.mode}, expression: "${config.expression}"). Action: ${action}.`,
      artifactType: 'output',
      metadata: { stepName: step.name, stepType: 'condition' },
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Gate Step
  // --------------------------------------------------------------------------

  private async runGateStep(
    pipelineId: string,
    step: PipelineStep
  ): Promise<StepArtifact> {
    const config = step.config as GateStepConfig;

    pipelineStore.setStepStatus(pipelineId, step.id, 'waiting_approval');

    if (!this.callbacks.onGateWaiting) {
      throw new Error('No gate approval handler configured');
    }

    const approved = await this.callbacks.onGateWaiting(step.id, config.approvalPrompt);

    if (!approved) {
      throw new Error('Gate step rejected by user');
    }

    return {
      stepId: step.id,
      content: 'Approved',
      artifactType: 'approval',
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Memory Capture
  // --------------------------------------------------------------------------

  private async captureMemory(pipeline: Pipeline, workingDir: string): Promise<void> {
    const schedule = pipeline.settings.schedule;
    if (!schedule?.maintainMemory) return;

    const allSteps = pipeline.stages.flatMap((s) => s.steps);
    const captureIds = schedule.captureStepIds;

    // Determine which steps to capture
    let stepsToCapture: PipelineStep[];
    if (captureIds && captureIds.length > 0) {
      stepsToCapture = captureIds
        .map((id) => allSteps.find((s) => s.id === id))
        .filter((s): s is PipelineStep => s !== undefined && s.artifact !== undefined);
    } else {
      // Default: capture last completed step
      const lastCompleted = [...allSteps].reverse().find((s) => s.status === 'completed' && s.artifact);
      stepsToCapture = lastCompleted ? [lastCompleted] : [];
    }

    if (stepsToCapture.length === 0) return;

    // Build captures map keyed by sanitized step name
    const captures: Record<string, string> = {};
    for (const step of stepsToCapture) {
      const key = sanitizeFolderName(step.name);
      captures[key] = step.artifact!.content;
    }

    const runNumber = this.currentRunNumber || await getNextRunNumber(this.platform, workingDir, pipeline.id);

    await appendEntry(this.platform, workingDir, pipeline.id, {
      runNumber,
      runDate: new Date().toISOString(),
      captures,
    });
  }

  // --------------------------------------------------------------------------
  // Run Manifest
  // --------------------------------------------------------------------------

  private async writeManifest(
    pipeline: Pipeline,
    status: 'completed' | 'failed',
    memoryUpdated: boolean
  ): Promise<void> {
    if (!this.currentRunDir) return;

    const allSteps = pipeline.stages.flatMap((s) => s.steps);
    const totalTokens = allSteps.reduce(
      (sum, s) => sum + (s.artifact?.metadata?.tokensUsed || 0), 0
    );
    const startMs = this.runStartedAt ? new Date(this.runStartedAt).getTime() : Date.now();

    const manifest: RunManifest = {
      runNumber: this.currentRunNumber,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      startedAt: this.runStartedAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status,
      initialInput: pipeline.initialInput,
      stageCount: pipeline.stages.length,
      stepCount: allSteps.length,
      totalTokens,
      totalDurationMs: Date.now() - startMs,
      memoryUpdated,
    };

    await writeRunManifest(this.platform, this.currentRunDir, manifest);
  }

  // --------------------------------------------------------------------------
  // Step Location Helper
  // --------------------------------------------------------------------------

  private findStepLocation(pipelineId: string, stepId: string): {
    stageIndex: number;
    stageName: string;
    stepIndex: number;
  } | null {
    const pipeline = pipelineStore.get(pipelineId);
    if (!pipeline) return null;

    for (let si = 0; si < pipeline.stages.length; si++) {
      const stage = pipeline.stages[si];
      for (let sti = 0; sti < stage.steps.length; sti++) {
        if (stage.steps[sti].id === stepId) {
          return { stageIndex: si, stageName: stage.name, stepIndex: sti };
        }
      }
    }
    return null;
  }
}
