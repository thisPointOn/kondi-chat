/**
 * Council: Multi-Model Deliberation System
 * Main export file
 */

// Types
export * from './types';

// Validation
export * from './validation';

// Templates
export {
  strategicTemplates,
  technicalTemplates,
  creativeTemplates,
  domainTemplates,
  allTemplates,
  templatesByCategory,
  templateCategories,
  getTemplateByName,
  getTemplatesByCategory,
  createPersonaFromTemplate,
  suggestedCombinations,
} from './templates';

// Store
export {
  getAllCouncils,
  getCouncil,
  createCouncil,
  updateCouncil,
  deleteCouncil,
  addPersona,
  updatePersona,
  removePersona,
  setPersonaMuted,
  addMessage,
  getMessages,
  setCouncilStatus,
  setResolution,
  updateCost,
  searchCouncils,
  getCouncilsByStatus,
  getActiveCouncils,
  getRecentCouncils,
  exportCouncil,
  importCouncil,
  duplicateCouncil,
  councilStore,
  CouncilStore,
  // Deliberation state operations
  initializeDeliberationState,
  updateDeliberationState,
  setDeliberationPhase,
  advanceDeliberationRound,
  recordRoundSubmission,
  isRoundComplete,
  setRoleAssignments,
  addPendingPatch,
  removePendingPatch,
  setRoundSummary,
  setActiveContext,
  setManagerEvaluation,
  setFinalDecision,
  setWorkDirective,
  setCurrentOutput,
  incrementRevisionCount,
  addErrorToLog,
  getPersonaByRole,
  getRoleAssignment,
  isDeliberationMode,
  deleteCouncilWithData,
} from './store';

// Prompts
export {
  buildPersonaSystemPrompt,
  buildConversationContext,
  buildSynthesisPrompt,
  buildDebatePrompt,
  buildSteelmanPrompt,
  buildCommonGroundPrompt,
  buildAskPrompt,
  buildVotePrompt,
  extractOpenQuestions,
  // Deliberation prompts
  getMinimalWorkerSystemPrompt,
  buildManagerFramingPrompt,
  buildManagerEvaluationPrompt,
  buildManagerDecisionPrompt,
  buildManagerForcedDecisionPrompt,
  buildManagerPlanPrompt,
  buildWorkDirectivePrompt,
  buildManagerReviewPrompt,
  buildManagerRoundSummaryPrompt,
  buildIndependentAnalysisPrompt,
  buildDeliberationResponsePrompt,
  buildWorkerExecutionPrompt,
  buildWorkerRevisionPrompt,
} from './prompts';

// Turn Strategies
export {
  selectNextSpeaker,
  isRoundComplete as isRoundCompleteForCouncil,
  getUnheardPersonas,
  selectDebateOpponents,
  calculateRoundOrder,
} from './turn-strategies';

// Synthesis
export {
  parseSynthesisResponse,
  calculateConsensus,
  extractKeyClaims,
  findAgreements,
  findTensions,
  summarizePositions,
  prepareSynthesisRequest,
  quickConsensusCheck,
  createRoundSummary,
} from './synthesis';

// Orchestrator
export {
  CouncilOrchestrator,
  createOrchestrator,
  estimateTurnCost,
  estimateRoundCost,
  type LLMProvider,
  type OrchestratorConfig,
} from './orchestrator';

// Ledger Store
export {
  appendEntry,
  getEntries,
  getAllEntries,
  getEntry,
  getLatestOfType,
  getEntriesForRound,
  getEntriesByAuthor,
  getLedgerTokenCount,
  getManagerNotes,
  formatEntriesForContext,
  buildMechanicalSummary,
  ledgerStore,
  LedgerStore,
} from './ledger-store';

// Context Store
export {
  // Context operations
  getCurrentContext,
  getContextHistory,
  getContextVersion,
  createInitialContext,
  createContextVersion,
  getContextDiff,
  // Patch operations
  getAllPatches,
  getPendingPatches,
  getPatch,
  createPatch,
  acceptPatch,
  rejectPatch,
  isPatchStale,
  // Decision
  getDecision,
  createDecision,
  // Plan
  getPlan,
  createPlan,
  // Directive
  getDirective,
  createDirective,
  // Output
  getAllOutputs,
  getLatestOutput,
  getOutput,
  createOutput,
  createRevisionOutput,
  // Cleanup
  deleteAllArtifacts,
  hasArtifacts,
  // Class & instance
  contextStore,
  ContextStore,
} from './context-store';

// Factory
export {
  createCouncilFromSetup,
  type CouncilSetup,
} from './factory';

// Deliberation Orchestrator
export {
  DeliberationOrchestrator,
} from './deliberation-orchestrator';
