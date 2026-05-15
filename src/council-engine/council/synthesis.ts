/**
 * Council: Synthesis Generation
 * Generate summaries, resolutions, and consensus analysis
 */

import type { Council, Persona, Resolution, CouncilMessage } from './types';
import { buildSynthesisPrompt } from './prompts';

/**
 * Default synthesis model (can be overridden)
 */
const DEFAULT_SYNTHESIS_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_SYNTHESIS_PROVIDER = 'anthropic';

/**
 * Parse synthesis response from LLM
 */
export function parseSynthesisResponse(response: string): Resolution | null {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Synthesis] No JSON found in response');
      return null;
    }

    const data = JSON.parse(jsonMatch[0]);

    return {
      summary: data.summary || '',
      consensusLevel: typeof data.consensusLevel === 'number' ? data.consensusLevel : 0.5,
      keyDecisions: Array.isArray(data.keyDecisions) ? data.keyDecisions : [],
      agreements: Array.isArray(data.agreements) ? data.agreements : [],
      tensions: Array.isArray(data.tensions) ? data.tensions : [],
      dissent: Array.isArray(data.dissent) ? data.dissent : [],
      nextSteps: Array.isArray(data.nextSteps) ? data.nextSteps : [],
      generatedBy: 'system',
    };
  } catch (error) {
    console.error('[Synthesis] Failed to parse response:', error);
    return null;
  }
}

/**
 * Calculate consensus level from message sentiments
 */
export function calculateConsensus(council: Council): number {
  const personaMessages = council.messages.filter((m) => m.speakerType === 'persona');
  if (personaMessages.length === 0) return 0;

  // Count agreements and disagreements
  let agreements = 0;
  let disagreements = 0;

  for (const message of personaMessages) {
    if (message.sentiment === 'agree') agreements++;
    else if (message.sentiment === 'disagree') disagreements++;
    else if (message.sentiment === 'partial') {
      agreements += 0.5;
      disagreements += 0.5;
    }
  }

  const total = agreements + disagreements;
  if (total === 0) return 0.5; // Neutral if no explicit sentiments

  return agreements / total;
}

/**
 * Identify key claims made in the discussion
 */
export function extractKeyClaims(council: Council): string[] {
  const claims: string[] = [];

  for (const message of council.messages) {
    if (message.claims) {
      for (const claim of message.claims) {
        if (claim.type === 'assertion' || claim.type === 'proposal') {
          claims.push(claim.text);
        }
      }
    }
  }

  return claims;
}

/**
 * Identify points of agreement across personas
 */
export function findAgreements(council: Council): string[] {
  // Look for messages where sentiment is 'agree' and extract what they agree on
  const agreements: string[] = [];

  for (let i = 1; i < council.messages.length; i++) {
    const message = council.messages[i];
    if (message.sentiment === 'agree' && message.replyingTo) {
      const original = council.messages.find((m) => m.id === message.replyingTo);
      if (original) {
        // Extract first sentence as the point of agreement
        const firstSentence = original.content.split(/[.!?]/)[0];
        if (firstSentence && firstSentence.length > 10) {
          agreements.push(firstSentence.trim());
        }
      }
    }
  }

  return [...new Set(agreements)];
}

/**
 * Identify key tensions/disagreements
 */
export function findTensions(council: Council): Array<{ between: [string, string]; topic: string }> {
  const tensions: Array<{ between: [string, string]; topic: string }> = [];

  for (let i = 1; i < council.messages.length; i++) {
    const message = council.messages[i];
    if (message.sentiment === 'disagree' && message.replyingTo) {
      const original = council.messages.find((m) => m.id === message.replyingTo);
      if (original && original.speakerType === 'persona') {
        const speaker1 = council.personas.find((p) => p.id === original.speakerId);
        const speaker2 = council.personas.find((p) => p.id === message.speakerId);

        if (speaker1 && speaker2) {
          tensions.push({
            between: [speaker1.name, speaker2.name],
            topic: original.content.slice(0, 100),
          });
        }
      }
    }
  }

  return tensions;
}

/**
 * Generate position summary for each persona
 */
export function summarizePositions(
  council: Council
): Array<{ persona: string; position: string; confidence: number }> {
  const positions: Array<{ persona: string; position: string; confidence: number }> = [];

  for (const persona of council.personas) {
    const personaMessages = council.messages
      .filter((m) => m.speakerId === persona.id)
      .slice(-3);

    if (personaMessages.length === 0) {
      positions.push({
        persona: persona.name,
        position: 'Has not spoken yet',
        confidence: 0,
      });
      continue;
    }

    // Use the last message's stance or summarize
    const lastMessage = personaMessages[personaMessages.length - 1];
    positions.push({
      persona: persona.name,
      position: lastMessage.stance || lastMessage.content.slice(0, 150),
      confidence: lastMessage.confidence || 0.5,
    });
  }

  return positions;
}

/**
 * Configuration for synthesis generation
 */
export interface SynthesisConfig {
  synthesizer?: 'system' | Persona;
  model?: string;
  provider?: string;
  includeVotes?: boolean;
}

/**
 * Generate synthesis request parameters
 * Returns the prompt and model configuration for the caller to execute
 */
export function prepareSynthesisRequest(
  council: Council,
  config?: SynthesisConfig
): {
  prompt: string;
  model: string;
  provider: string;
  synthesizerId: string;
} {
  const synthesizer = config?.synthesizer;
  const isPersona = synthesizer && synthesizer !== 'system';

  return {
    prompt: buildSynthesisPrompt(council),
    model: isPersona ? (synthesizer as Persona).model : (config?.model || DEFAULT_SYNTHESIS_MODEL),
    provider: isPersona ? (synthesizer as Persona).provider : (config?.provider || DEFAULT_SYNTHESIS_PROVIDER),
    synthesizerId: isPersona ? (synthesizer as Persona).id : 'system',
  };
}

/**
 * Quick consensus check (heuristic-based, no LLM call)
 */
export function quickConsensusCheck(council: Council): {
  level: number;
  status: 'converging' | 'diverging' | 'stable';
  recommendation: string;
} {
  const recentMessages = council.messages.slice(-10);
  const personaMessages = recentMessages.filter((m) => m.speakerType === 'persona');

  if (personaMessages.length < 3) {
    return {
      level: 0.5,
      status: 'stable',
      recommendation: 'Continue discussion to gather more perspectives',
    };
  }

  // Count sentiment trends
  let recentAgree = 0;
  let recentDisagree = 0;

  for (const msg of personaMessages.slice(-5)) {
    if (msg.sentiment === 'agree') recentAgree++;
    if (msg.sentiment === 'disagree') recentDisagree++;
  }

  const level = recentAgree / (recentAgree + recentDisagree || 1);

  if (recentAgree > recentDisagree * 2) {
    return {
      level,
      status: 'converging',
      recommendation: 'Consider generating a resolution',
    };
  }

  if (recentDisagree > recentAgree * 2) {
    return {
      level,
      status: 'diverging',
      recommendation: 'Consider a synthesis to identify common ground',
    };
  }

  return {
    level,
    status: 'stable',
    recommendation: 'Continue discussion or ask specific questions',
  };
}

/**
 * Create a round summary message
 */
export function createRoundSummary(
  council: Council,
  roundNumber: number
): CouncilMessage {
  const consensus = quickConsensusCheck(council);
  const positions = summarizePositions(council);

  const positionSummary = positions
    .map((p) => `• **${p.persona}**: ${p.position.slice(0, 100)}${p.position.length > 100 ? '...' : ''}`)
    .join('\n');

  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    speakerId: 'system',
    speakerType: 'system',
    content: `**Round ${roundNumber} Summary**

${positionSummary}

Consensus level: ${Math.round(consensus.level * 100)}%
Status: ${consensus.status}
${consensus.recommendation}`,
    tokensUsed: 0,
    latencyMs: 0,
  };
}
