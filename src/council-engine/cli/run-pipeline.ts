#!/usr/bin/env -S npx tsx
/**
 * CLI Pipeline Runner
 *
 * Usage:
 *   npx tsx cli/run-pipeline.ts <pipeline.json> [--working-dir <path>] [--model <model>] [--dry-run]
 *
 * Loads a pipeline JSON exported from the Kondi app and runs it using the same
 * executor/orchestrator code, with output printed to the terminal.
 *
 * All personas, descriptions, inputs and outputs of every step are stored
 * in an execution report saved to the working directory after completion.
 */

// ── localStorage shim MUST be imported first ──
import { storage } from './localStorage-shim';

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pipelineStore } from '../pipeline/store';
import { PipelineExecutor } from '../pipeline/executor';
import type { PlatformAdapter } from '../pipeline/executor';
import type { Pipeline, CouncilStepConfig, LlmStepConfig, ScriptStepConfig, ConditionStepConfig } from '../pipeline/types';
import { migrateLlmConfig } from '../pipeline/types';
import { callLLM } from './llm-caller';
import { createNodePlatform } from './node-platform';
import { exportSession } from './session-export';
import { createBudgetAwareInvoker } from '../budget/budget-aware-invoker';
import { mapStepTypeToStage } from '../budget/phase-stage-map';
import type { ModelTier } from '../budget/budget-tracker';

// ── ANSI colors ──
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function log(color: string, prefix: string, msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${C.dim}${ts}${C.reset} ${color}${C.bold}[${prefix}]${C.reset} ${msg}`);
}

// ── Execution log (captures all step inputs/outputs for the report) ──
interface StepExecutionRecord {
  stepId: string;
  stepName: string;
  stepType: string;
  stageName: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: string;
  error?: string;
  // Council-based steps
  personas?: Array<{
    name: string;
    role: string;
    model: string;
    provider: string;
    traits?: string[];
    domain?: string;
    suppressPersona?: boolean;
  }>;
  councilName?: string;
  councilId?: string;
  maxRounds?: number;
  maxRevisions?: number;
  expectedOutput?: string;
  // Input/output
  inputTemplate?: string;
  resolvedInput?: string;
  output?: string;
  outputPath?: string;
  artifactType?: string;
  tokensUsed?: number;
}

const executionLog: StepExecutionRecord[] = [];

// ── Parse CLI args ──
function parseArgs() {
  const args = process.argv.slice(2);
  let pipelineFile: string | null = null;
  let workingDir: string | null = null;
  let model: string | null = null;
  let pipelineName: string | null = null;
  let dryRun = false;
  let noCache = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--working-dir' && args[i + 1]) {
      workingDir = path.resolve(args[++i]);
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      pipelineName = args[++i];
    } else if (args[i] === '--no-cache') {
      noCache = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
${C.bold}Kondi CLI Pipeline Runner${C.reset}

Usage:
  npx tsx cli/run-pipeline.ts <pipeline.json> [options]

Options:
  --working-dir <path>   Override the pipeline's working directory
  --model <model>        Override the model for all LLM steps
  --name <name>          Select pipeline by name (when file contains multiple)
  --no-cache             Disable Anthropic prompt caching (same as KONDI_NO_CACHE=1)
  --dry-run              Print pipeline structure without running
  --help                 Show this help

Accepts two JSON formats:
  1. Single pipeline (exported via "Export" button in the app)
  2. Wrapped format: { "pipelines": [...] } — use --name to pick one

Output:
  After execution, a comprehensive execution report is saved to:
    <working-dir>/kondi-execution-report.json
  This includes all personas, step inputs/outputs, timing, and artifacts.
`);
      process.exit(0);
    } else if (!args[i].startsWith('--')) {
      pipelineFile = path.resolve(args[i]);
    }
  }

  if (!pipelineFile) {
    console.error(`${C.red}Error: No pipeline JSON file specified.${C.reset}`);
    console.error(`Usage: npx tsx cli/run-pipeline.ts <pipeline.json> [--working-dir <path>]`);
    process.exit(1);
  }

  return { pipelineFile, workingDir, model, pipelineName, dryRun, noCache };
}

// ── Load pipeline JSON ──
function loadPipeline(
  filePath: string,
  workingDirOverride?: string | null,
  modelOverride?: string | null,
  pipelineName?: string | null,
): Pipeline {
  if (!fs.existsSync(filePath)) {
    console.error(`${C.red}Error: File not found: ${filePath}${C.reset}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);

  // Detect format: wrapped { pipelines: [...] } vs single Pipeline object
  let pipeline: Pipeline;

  if (Array.isArray(parsed.pipelines)) {
    // Wrapped format (localStorage export or multi-pipeline file)
    const list: Pipeline[] = parsed.pipelines;
    if (list.length === 0) {
      console.error(`${C.red}Error: No pipelines found in file.${C.reset}`);
      process.exit(1);
    }

    if (pipelineName) {
      const match = list.find(p =>
        p.name.toLowerCase() === pipelineName.toLowerCase() ||
        p.name.toLowerCase().includes(pipelineName.toLowerCase())
      );
      if (!match) {
        console.error(`${C.red}Error: No pipeline matching "${pipelineName}". Available:${C.reset}`);
        for (const p of list) console.error(`  - ${p.name}`);
        process.exit(1);
      }
      pipeline = match;
    } else if (list.length === 1) {
      pipeline = list[0];
    } else {
      console.error(`${C.yellow}Multiple pipelines found. Use --name to select one:${C.reset}`);
      for (const p of list) console.error(`  - ${p.name}`);
      process.exit(1);
    }
  } else if (parsed.id && Array.isArray(parsed.stages)) {
    // Single pipeline object (exported from app)
    pipeline = parsed as Pipeline;
  } else {
    console.error(`${C.red}Error: Invalid pipeline JSON — expected a Pipeline object or { pipelines: [...] }.${C.reset}`);
    process.exit(1);
  }

  // Apply overrides
  if (workingDirOverride) {
    pipeline.settings.workingDirectory = workingDirOverride;
  }

  // Reset execution state for a fresh run
  pipeline.status = 'ready';
  pipeline.currentStageIndex = 0;
  for (const stage of pipeline.stages) {
    for (const step of stage.steps) {
      step.status = 'pending';
      step.artifact = undefined;
      step.error = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
    }
  }

  return pipeline;
}

// ── Print pipeline structure with full persona details ──
function printPipelineStructure(pipeline: Pipeline) {
  console.log(`\n${C.bold}${C.cyan}Pipeline: ${pipeline.name}${C.reset}`);
  if (pipeline.description) console.log(`${C.dim}${pipeline.description}${C.reset}`);
  console.log(`${C.dim}Working directory: ${pipeline.settings.workingDirectory || '(not set)'}${C.reset}`);
  console.log(`${C.dim}Failure policy: ${pipeline.settings.failurePolicy}${C.reset}`);
  if (pipeline.initialInput) {
    console.log(`\n${C.bold}Initial Input:${C.reset}`);
    console.log(`${C.dim}${pipeline.initialInput.slice(0, 300)}${pipeline.initialInput.length > 300 ? '...' : ''}${C.reset}`);
  }
  console.log();

  for (let i = 0; i < pipeline.stages.length; i++) {
    const stage = pipeline.stages[i];
    console.log(`  ${C.bold}Stage ${i + 1}: ${stage.name}${C.reset} (${stage.executionMode || 'sequential'})`);
    for (const step of stage.steps) {
      const typeColor = step.config.type === 'gate' ? C.yellow :
                        step.config.type === 'coding' ? C.magenta :
                        step.config.type === 'code_planning' ? C.blue :
                        step.config.type === 'council' ? C.yellow :
                        step.config.type === 'script' ? C.cyan :
                        step.config.type === 'condition' ? C.yellow : C.green;
      console.log(`    ${typeColor}[${step.config.type}]${C.reset} ${step.name}`);
      if (step.description) {
        console.log(`      ${C.dim}${step.description}${C.reset}`);
      }

      // Show personas for council steps (all non-gate types with councilSetup)
      if ('councilSetup' in step.config) {
        const config = step.config as CouncilStepConfig;
        console.log(`      ${C.dim}Council: ${config.councilSetup.name}${C.reset}`);
        console.log(`      ${C.dim}Rounds: ${config.councilSetup.maxRounds ?? 4}, Revisions: ${config.councilSetup.maxRevisions ?? 3}${C.reset}`);
        if (config.councilSetup.expectedOutput) {
          console.log(`      ${C.dim}Expected: ${config.councilSetup.expectedOutput.slice(0, 120)}...${C.reset}`);
        }
        for (const p of config.councilSetup.personas) {
          const roleColor = p.role === 'manager' ? C.blue :
                           p.role === 'worker' ? C.yellow :
                           p.role === 'reviewer' ? C.cyan : C.green;
          console.log(`        ${roleColor}${p.avatar || ''} ${p.name}${C.reset} (${p.role}) — ${p.model}`);
          if (p.domain) console.log(`          ${C.dim}Domain: ${p.domain}${C.reset}`);
          if (p.traits?.length) console.log(`          ${C.dim}Traits: ${p.traits.join(', ')}${C.reset}`);
        }
      }

      // Show script command
      if (step.config.type === 'script') {
        const config = step.config as ScriptStepConfig;
        console.log(`      ${C.dim}Command: ${config.command || '(empty)'}${C.reset}`);
        if (config.outputType && config.outputType !== 'string') {
          console.log(`      ${C.dim}Output: ${config.outputType}${C.reset}`);
        }
      }

      // Show condition config
      if (step.config.type === 'condition') {
        const config = step.config as ConditionStepConfig;
        console.log(`      ${C.dim}Mode: ${config.mode}, Expression: "${config.expression}"${C.reset}`);
        console.log(`      ${C.dim}If TRUE: ${config.trueAction}, If FALSE: ${config.falseAction}${C.reset}`);
      }

      // Show model for lightweight council steps (analysis/agent)
      if (step.config.type === 'analysis' || step.config.type === 'agent') {
        if ('councilSetup' in step.config) {
          const config = step.config as CouncilStepConfig;
          for (const p of config.councilSetup.personas) {
            console.log(`        ${C.dim}${p.name} (${p.role}) — ${p.model}${C.reset}`);
          }
        } else {
          const config = step.config as LlmStepConfig;
          console.log(`      ${C.dim}Model: ${config.model} (${config.provider})${C.reset}`);
        }
      }
    }
  }
  console.log();
}

// ── Interactive gate prompt ──
async function promptGate(stepId: string, prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log(`\n${C.yellow}${C.bold}GATE: ${prompt}${C.reset}`);
    rl.question(`${C.yellow}Approve? (y/n): ${C.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// ── Save execution report ──
function saveExecutionReport(
  pipeline: Pipeline,
  workingDir: string,
  startTime: number,
  status: 'completed' | 'failed',
  error?: string,
) {
  const finalPipeline = pipelineStore.get(pipeline.id) || pipeline;
  const elapsed = Date.now() - startTime;

  const report = {
    pipeline: {
      id: finalPipeline.id,
      name: finalPipeline.name,
      description: finalPipeline.description,
      initialInput: finalPipeline.initialInput,
      workingDirectory: finalPipeline.settings.workingDirectory,
      failurePolicy: finalPipeline.settings.failurePolicy,
      directoryConstrained: finalPipeline.settings.directoryConstrained,
    },
    execution: {
      status,
      error,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: elapsed,
      durationHuman: formatDuration(elapsed),
    },
    stages: finalPipeline.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      executionMode: stage.executionMode || 'sequential',
      steps: stage.steps.map((step) => {
        // Find matching execution log entry
        const logEntry = executionLog.find(e => e.stepId === step.id);

        const stepReport: Record<string, any> = {
          id: step.id,
          name: step.name,
          description: step.description,
          type: step.config.type,
          status: step.status,
          error: step.error,
          startedAt: step.startedAt || logEntry?.startedAt,
          completedAt: step.completedAt || logEntry?.completedAt,
          durationMs: logEntry?.durationMs,
        };

        // Council step details (all non-gate types with councilSetup)
        if ('councilSetup' in step.config) {
          const config = step.config as CouncilStepConfig;
          stepReport.council = {
            name: config.councilSetup.name,
            councilId: logEntry?.councilId,
            maxRounds: config.councilSetup.maxRounds,
            maxRevisions: config.councilSetup.maxRevisions,
            expectedOutput: config.councilSetup.expectedOutput,
            personas: config.councilSetup.personas.map(p => ({
              name: p.name,
              role: p.role,
              model: p.model,
              provider: p.provider,
              avatar: p.avatar,
              traits: p.traits,
              domain: p.domain,
              suppressPersona: p.suppressPersona,
              saveOutput: p.saveOutput,
            })),
          };
          if (step.config.type === 'coding') {
            stepReport.council.testCommand = config.councilSetup.testCommand;
            stepReport.council.maxDebugCycles = config.councilSetup.maxDebugCycles;
            stepReport.council.maxReviewCycles = config.councilSetup.maxReviewCycles;
          }
        }

        // Lightweight council step details (analysis/agent)
        if (step.config.type === 'analysis' || step.config.type === 'agent') {
          if ('councilSetup' in step.config) {
            const config = step.config as CouncilStepConfig;
            stepReport.council = {
              name: config.councilSetup.name,
              councilId: logEntry?.councilId,
              maxRounds: config.councilSetup.maxRounds,
              maxRevisions: config.councilSetup.maxRevisions,
              personas: config.councilSetup.personas.map(p => ({
                name: p.name, role: p.role, model: p.model, provider: p.provider,
              })),
            };
          } else {
            const config = step.config as LlmStepConfig;
            stepReport.llm = {
              model: config.model,
              provider: config.provider,
              systemPrompt: config.systemPrompt,
            };
          }
        }

        // Input/output
        stepReport.inputTemplate = (step.config as any).inputTemplate;
        stepReport.resolvedInput = logEntry?.resolvedInput;

        // Artifact (output)
        if (step.artifact) {
          stepReport.artifact = {
            type: step.artifact.artifactType,
            contentLength: step.artifact.content.length,
            contentPreview: step.artifact.content.slice(0, 500),
            outputPath: step.artifact.metadata?.outputPath,
            tokensUsed: step.artifact.metadata?.tokensUsed,
            councilId: step.artifact.metadata?.councilId,
            createdAt: step.artifact.createdAt,
          };
        }

        return stepReport;
      }),
    })),
    steps: executionLog,
  };

  const reportPath = path.join(workingDir, 'kondi-execution-report.json');
  try {
    fs.mkdirSync(workingDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    log(C.cyan, 'Report', `Execution report saved to: ${reportPath}`);
  } catch (err) {
    console.error(`${C.red}Failed to save execution report:${C.reset}`, err);
  }

  return reportPath;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remaining = s % 60;
  if (m < 60) return `${m}m ${remaining}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${remaining}s`;
}

// ── Main ──
async function main() {
  const { pipelineFile, workingDir, model, pipelineName, dryRun, noCache } = parseArgs();
  const pipeline = loadPipeline(pipelineFile, workingDir, model, pipelineName);

  printPipelineStructure(pipeline);

  if (dryRun) {
    console.log(`${C.dim}--dry-run: exiting without executing.${C.reset}`);
    process.exit(0);
  }

  // Push pipeline into store (so executor can read/update it)
  const storedPipelines = pipelineStore.getAll();
  const existing = storedPipelines.find(p => p.id === pipeline.id);
  if (existing) {
    // Update in place
    pipelineStore.update(pipeline.id, {
      ...pipeline,
      status: 'ready',
      currentStageIndex: 0,
    });
    // Reset all steps
    for (const stage of pipeline.stages) {
      for (const step of stage.steps) {
        pipelineStore.setStepStatus(pipeline.id, step.id, 'pending');
      }
    }
  } else {
    // Manually write into localStorage since create() generates a new id
    const data = JSON.parse(storage.getItem('mcp-pipelines') || '{"version":5,"pipelines":[],"lastUpdated":""}');
    data.pipelines.push(pipeline);
    data.lastUpdated = new Date().toISOString();
    storage.setItem('mcp-pipelines', JSON.stringify(data));
  }

  // Resolve and validate working dir
  const effectiveWorkingDir = pipeline.settings.workingDirectory || process.cwd();
  if (!fs.existsSync(effectiveWorkingDir)) {
    console.error(`${C.red}Error: Working directory does not exist: ${effectiveWorkingDir}${C.reset}`);
    console.error(`${C.dim}Set it in the pipeline JSON under settings.workingDirectory, or use --working-dir${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.dim}Working directory: ${effectiveWorkingDir}${C.reset}`);

  // Create platform adapter
  const platform: PlatformAdapter = createNodePlatform(effectiveWorkingDir);

  // Track execution time and step timing
  const startTime = Date.now();
  const stepTimers: Record<string, number> = {};

  // Create budget-aware invoker with persistence
  const budgetInvoker = createBudgetAwareInvoker({
    verbose: true,
    restoreState: true,
  });

  // Track current step type for budget stage mapping
  // Initialize to 'council' to ensure first call (before step execution) maps to 'deliberation'
  let currentStepType: string = 'council';

  // Create executor
  const executor = new PipelineExecutor({
    invokeAgent: async (invocation, persona) => {
      log(C.cyan, persona.name, `Invoking (${persona.model})...`);

      // Map current step type to budget stage
      const budgetStage = mapStepTypeToStage(currentStepType as any);

      // Determine requested tier based on provider/model
      let requestedTier: ModelTier = 'openai-mini';
      if (persona.provider === 'anthropic-api' || persona.model?.includes('claude')) {
        requestedTier = 'anthropic-premium';
      } else if (persona.model?.includes('gpt-4o') && !persona.model?.includes('mini')) {
        requestedTier = 'openai-mid';
      }

      // Build allowedTools from allowedServerIds if set
      const allowedTools = invocation.allowedServerIds
        ? ['Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep', ...invocation.allowedServerIds.map(id => `mcp__${id}`)]
        : undefined;

      // Use generous timeouts: workers get 30 min, Opus models get 20 min, others get 15 min.
      const isWorker = persona.preferredDeliberationRole === 'worker';
      const isOpus = persona.model?.includes('opus');
      const timeoutMs = isWorker ? 1_800_000 : isOpus ? 1_200_000 : 900_000;

      // Use budget-aware invoker
      const result = await budgetInvoker.invoke({
        stage: budgetStage,
        requestedTier,
        persona,
        invocation: {
          systemPrompt: invocation.systemPrompt,
          userMessage: invocation.userMessage,
          workingDirectory: platform.getWorkingDir(),
          skipTools: invocation.skipTools,
          allowedTools,
          timeoutMs,
          cacheableContext: invocation.cacheableContext,
        },
      });

      log(C.cyan, persona.name, `Done (${result.tokensUsed} tokens, ${(result.latencyMs / 1000).toFixed(1)}s, $${result.costUSD.toFixed(4)})`);
      if (result.downgraded) {
        log(C.yellow, 'Budget', `Downgraded to ${result.actualTier} (${result.reasonCode})`);
      }

      return { ...result, sessionId: result.sessionId };
    },

    onStageStart: (idx) => {
      const stage = pipelineStore.get(pipeline.id)?.stages[idx];
      log(C.blue, 'Stage', `Starting stage ${idx + 1}: ${stage?.name || '?'}`);
    },

    onStageComplete: (idx) => {
      const stage = pipelineStore.get(pipeline.id)?.stages[idx];
      log(C.green, 'Stage', `Completed stage ${idx + 1}: ${stage?.name || '?'}`);
    },

    onStepStart: (stepId) => {
      const p = pipelineStore.get(pipeline.id);
      const step = p?.stages.flatMap(s => s.steps).find(s => s.id === stepId);
      const stageName = p?.stages.find(s => s.steps.some(st => st.id === stepId))?.name || '?';
      log(C.magenta, 'Step', `${step?.name || stepId} [${step?.config.type || '?'}]`);
      stepTimers[stepId] = Date.now();

      // Track current step type for budget mapping
      if (step) {
        currentStepType = step.config.type;
      }

      // Create execution log entry
      const record: StepExecutionRecord = {
        stepId,
        stepName: step?.name || stepId,
        stepType: step?.config.type || 'unknown',
        stageName,
        startedAt: new Date().toISOString(),
        status: 'running',
      };

      // Capture personas for council steps (all non-gate types with councilSetup)
      if (step && 'councilSetup' in step.config) {
        const config = step.config as CouncilStepConfig;
        record.councilName = config.councilSetup.name;
        record.maxRounds = config.councilSetup.maxRounds;
        record.maxRevisions = config.councilSetup.maxRevisions;
        record.expectedOutput = config.councilSetup.expectedOutput;
        record.inputTemplate = config.inputTemplate;
        record.personas = config.councilSetup.personas.map(p => ({
          name: p.name,
          role: p.role,
          model: p.model,
          provider: p.provider,
          traits: p.traits,
          domain: p.domain,
          suppressPersona: p.suppressPersona,
        }));
      }

      if (step && (step.config.type === 'analysis' || step.config.type === 'agent')) {
        if ('councilSetup' in step.config) {
          const config = step.config as CouncilStepConfig;
          record.inputTemplate = config.inputTemplate;
          record.personas = config.councilSetup.personas.map(p => ({
            name: p.name, role: p.role, model: p.model, provider: p.provider,
          }));
        } else {
          const config = step.config as LlmStepConfig;
          record.inputTemplate = config.inputTemplate;
        }
      }

      executionLog.push(record);
    },

    onStepComplete: (stepId, artifact) => {
      const p = pipelineStore.get(pipeline.id);
      const step = p?.stages.flatMap(s => s.steps).find(s => s.id === stepId);
      const durationMs = stepTimers[stepId] ? Date.now() - stepTimers[stepId] : 0;
      log(C.green, 'Step', `${step?.name || stepId} completed (${formatDuration(durationMs)})`);
      if (artifact.metadata?.outputPath) {
        log(C.dim, 'Step', `  Output: ${artifact.metadata.outputPath}`);
      }
      // Print a preview of the artifact content
      const preview = artifact.content.slice(0, 200).replace(/\n/g, ' ');
      console.log(`${C.dim}  ${preview}${artifact.content.length > 200 ? '...' : ''}${C.reset}`);

      // Update execution log entry
      const entry = executionLog.find(e => e.stepId === stepId);
      if (entry) {
        entry.completedAt = new Date().toISOString();
        entry.durationMs = durationMs;
        entry.status = 'completed';
        entry.output = artifact.content;
        entry.outputPath = artifact.metadata?.outputPath;
        entry.artifactType = artifact.artifactType;
        entry.tokensUsed = artifact.metadata?.tokensUsed;
        entry.councilId = artifact.metadata?.councilId;
      }
    },

    onStepError: (stepId, error) => {
      const p = pipelineStore.get(pipeline.id);
      const step = p?.stages.flatMap(s => s.steps).find(s => s.id === stepId);
      log(C.red, 'Step', `${step?.name || stepId} failed: ${error}`);

      // Update execution log entry
      const entry = executionLog.find(e => e.stepId === stepId);
      if (entry) {
        entry.completedAt = new Date().toISOString();
        entry.durationMs = stepTimers[stepId] ? Date.now() - stepTimers[stepId] : 0;
        entry.status = 'failed';
        entry.error = error;
      }
    },

    onGateWaiting: promptGate,

    onCouncilCreated: (stepId, councilId) => {
      log(C.blue, 'Council', `Created ${councilId} for step ${stepId}`);
      // Record council ID in execution log
      const entry = executionLog.find(e => e.stepId === stepId);
      if (entry) entry.councilId = councilId;
    },

    onAgentThinkingStart: (persona) => {
      log(C.dim, 'Agent', `${persona.name} thinking...`);
    },

    onAgentThinkingEnd: (_persona) => {
      // Intentionally quiet
    },
  }, platform);

  // Run!
  log(C.bold, 'Pipeline', `Starting execution: ${pipeline.name}`);
  console.log();

  try {
    await executor.run(pipeline.id);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log();
    log(C.green, 'Pipeline', `Completed successfully in ${elapsed}s`);

    // Print final artifacts
    const finalPipeline = pipelineStore.get(pipeline.id);
    if (finalPipeline) {
      console.log(`\n${C.bold}Final Artifacts:${C.reset}`);
      for (const stage of finalPipeline.stages) {
        for (const step of stage.steps) {
          if (step.artifact) {
            console.log(`  ${C.cyan}${step.name}${C.reset}: ${step.artifact.artifactType}`);
            if (step.artifact.metadata?.outputPath) {
              console.log(`    ${C.dim}-> ${step.artifact.metadata.outputPath}${C.reset}`);
            }
          }
        }
      }
    }

    // Budget telemetry
    const telemetry = budgetInvoker.getTelemetry();
    console.log(`\n${C.bold}${C.cyan}Budget Summary${C.reset}`);
    console.log(`${C.dim}Total spend: $${telemetry.totalSpendUSD.toFixed(4)} (${telemetry.runUtilization.toFixed(1)}% of run cap)${C.reset}`);
    console.log(`${C.dim}Anthropic calls: ${telemetry.anthropicCalls} ($${telemetry.anthropicSpend.toFixed(4)})${C.reset}`);
    if (telemetry.downgrades > 0) {
      console.log(`${C.yellow}Downgrades: ${telemetry.downgrades}${C.reset}`);
      for (const d of telemetry.recentDowngrades) {
        console.log(`  ${C.dim}${d.fromTier} → ${d.toTier} (${d.reasonCode})${C.reset}`);
      }
    }

    // Save execution report
    saveExecutionReport(pipeline, effectiveWorkingDir, startTime, 'completed');

    // Export session for GUI import
    exportSession(pipeline.id, storage, {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      workingDirectory: effectiveWorkingDir,
    });
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log();
    log(C.red, 'Pipeline', `Failed after ${elapsed}s: ${(error as Error).message}`);

    // Save execution report even on failure
    saveExecutionReport(pipeline, effectiveWorkingDir, startTime, 'failed', (error as Error).message);

    // Export session for GUI import (even on failure)
    exportSession(pipeline.id, storage, {
      status: 'failed',
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      workingDirectory: effectiveWorkingDir,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}Unhandled error:${C.reset}`, err);
  process.exit(1);
});
