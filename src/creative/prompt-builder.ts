import { CreativeInput, ImagePrompt } from './types.ts';
import { LLMCaller } from '../providers/llm-caller.ts';

export class PromptBuilder {
  constructor(private llm: LLMCaller) {}

  async buildInitialPrompt(input: CreativeInput): Promise<ImagePrompt> {
    const systemPrompt = `You are an expert at creating detailed image generation prompts. 
    Create vivid, specific prompts that capture the essence of what the user wants.
    Include style, composition, lighting, mood, and technical details.`;

    const userPrompt = `Create an image generation prompt based on:
    Description: ${input.description}
    ${input.referenceUrl ? `Reference URL: ${input.referenceUrl}` : ''}
    ${input.imageUrls?.length ? `Reference images provided: ${input.imageUrls.length}` : ''}
    
    Return a JSON object with:
    - prompt: The main detailed prompt
    - negativePrompt: Things to avoid (optional)
    - style: Art style (optional)
    - aspectRatio: Image dimensions like "16:9" (optional)`;

    const response = await this.llm.call(systemPrompt, userPrompt);
    
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // Fallback: create basic prompt from response
    }

    return {
      prompt: response.trim(),
      style: "digital art"
    };
  }

  async refinePrompt(
    currentPrompt: ImagePrompt, 
    instruction: string
  ): Promise<ImagePrompt> {
    const systemPrompt = `You are an expert at refining image generation prompts based on user feedback.
    Maintain the core concept while applying the requested changes precisely.`;

    const userPrompt = `Current image prompt:
    ${JSON.stringify(currentPrompt, null, 2)}
    
    User's edit instruction: "${instruction}"
    
    Apply this change and return the updated prompt as JSON with the same structure.
    Make targeted changes based on the instruction while preserving unrelated aspects.`;

    const response = await this.llm.call(systemPrompt, userPrompt);
    
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // If parsing fails, update just the main prompt
      return {
        ...currentPrompt,
        prompt: response.trim()
      };
    }

    return currentPrompt;
  }
}