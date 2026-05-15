/**
 * Deliberation Summary Builder (Tauri-free)
 * Extracted from deliberationSaveService.ts so it can be used by the pipeline
 * executor without Tauri dependencies.
 */

import type { Council } from '../council/types';
import { getAllEntries, buildMechanicalSummary } from '../council/ledger-store';
import { getDecision, getLatestOutput } from '../council/context-store';

// ============================================================================
// Full Deliberation Builder
// ============================================================================

export function buildFullDeliberation(council: Council): string {
  const entries = getAllEntries(council.id);
  if (entries.length === 0) return '# Deliberation\n\nNo entries recorded.';

  // Group entries by round
  const rounds = new Map<number | 'none', typeof entries>();
  for (const entry of entries) {
    const key = entry.roundNumber ?? 'none';
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key)!.push(entry);
  }

  const getPersonaName = (personaId: string): string => {
    const persona = council.personas.find((p) => p.id === personaId);
    return persona?.name || personaId;
  };

  const getRoleName = (personaId: string): string => {
    const assignment = council.deliberation?.roleAssignments?.find(
      (r) => r.personaId === personaId
    );
    return assignment?.role || 'unknown';
  };

  let md = `# Deliberation: ${council.name}\n\n`;
  md += `**Topic:** ${council.topic}\n`;
  md += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Total Entries:** ${entries.length}\n\n---\n\n`;

  // Non-round entries first
  const noRound = rounds.get('none');
  if (noRound && noRound.length > 0) {
    for (const entry of noRound) {
      md += `### ${getPersonaName(entry.authorPersonaId)} (${getRoleName(entry.authorPersonaId)}) — ${entry.entryType}\n`;
      md += `*${new Date(entry.timestamp).toLocaleString()}*\n\n`;
      md += `${entry.content}\n\n---\n\n`;
    }
  }

  // Round entries
  const sortedRounds = Array.from(rounds.keys())
    .filter((k) => k !== 'none')
    .sort((a, b) => (a as number) - (b as number));

  for (const round of sortedRounds) {
    md += `## Round ${round}\n\n`;
    const roundEntries = rounds.get(round)!;
    for (const entry of roundEntries) {
      md += `### ${getPersonaName(entry.authorPersonaId)} (${getRoleName(entry.authorPersonaId)}) — ${entry.entryType}\n`;
      md += `*${new Date(entry.timestamp).toLocaleString()}*\n\n`;
      md += `${entry.content}\n\n---\n\n`;
    }
  }

  return md;
}

// ============================================================================
// Abbreviated Summary Builder
// ============================================================================

export function buildAbbreviatedSummary(council: Council): string {
  const entries = getAllEntries(council.id);
  if (entries.length === 0) return 'No deliberation entries.';

  let summary = `=== Deliberation Summary: ${council.name} ===\n\n`;

  // Consultant highlights (mechanical summary)
  const mechanicalSummary = buildMechanicalSummary(entries);
  if (mechanicalSummary) {
    // Replace persona IDs with names in the mechanical summary
    let namedSummary = mechanicalSummary;
    for (const p of council.personas) {
      namedSummary = namedSummary.replace(new RegExp(p.id, 'g'), p.name);
    }
    summary += `--- Consultant Highlights ---\n${namedSummary}\n\n`;
  }

  // Decision
  const decision = getDecision(council.id);
  if (decision) {
    summary += `--- Decision ---\n${decision.content}\n`;
    if (decision.acceptanceCriteria) {
      summary += `\nAcceptance Criteria: ${decision.acceptanceCriteria}\n`;
    }
    summary += '\n';
  }

  // Output (truncated)
  const output = getLatestOutput(council.id);
  if (output) {
    const maxLen = 2000;
    const truncated = output.content.length > maxLen
      ? output.content.slice(0, maxLen) + '\n\n[... truncated ...]'
      : output.content;
    summary += `--- Output (v${output.version}) ---\n${truncated}\n`;
  }

  return summary;
}
