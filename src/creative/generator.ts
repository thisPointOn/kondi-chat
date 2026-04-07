/**
 * Creative Generator — Handles creative content generation from descriptions and images
 */

import { readFile } from 'node:fs/promises';
import { CreativeGenerationRequest, CreativeGenerationResponse } from '../types.js';
import { callLLM } from '../providers/llm-caller.js';
import { selectModel } from '../router/index.js';

/**
 * Convert an image file to base64 encoding
 */
export async function imageToBase64(imagePath: string): Promise<string> {
  try {
    const buffer = await readFile(imagePath);
    return buffer.toString('base64');
  } catch (error) {
    throw new Error(`Failed to read image ${imagePath}: ${error}`);
  }
}

/**
 * Route creative tasks to appropriate models based on requirements
 */
async function routeCreativeTask(request: CreativeGenerationRequest): Promise<string> {
  // For now, use a simple heuristic. Later this can use the router's learning
  const hasImages = request.images && request.images.length > 0;
  const isCodeRelated = request.description.toLowerCase().includes('code') || 
                       request.description.toLowerCase().includes('function') ||
                       request.description.toLowerCase().includes('implement');
  
  if (hasImages) {
    // Prefer models with vision capabilities
    return 'claude-3-5-sonnet-20241022'; // Claude has good vision
  } else if (isCodeRelated) {
    // Code generation tasks
    return 'deepseek-chat'; // Good for code
  } else {
    // General creative tasks
    return 'claude-3-5-sonnet-20241022'; // Strong creative writing
  }
}

/**
 * Generate creative content based on description and optional images
 */
export async function generateCreative(
  request: CreativeGenerationRequest
): Promise<CreativeGenerationResponse> {
  // Build the prompt
  let prompt = `Generate creative content based on the following description:\n\n${request.description}`;
  
  if (request.style) {
    prompt += `\n\nStyle: ${request.style}`;
  }
  
  if (request.constraints && request.constraints.length > 0) {
    prompt += `\n\nConstraints:\n${request.constraints.map(c => `- ${c}`).join('\n')}`;
  }
  
  // Prepare messages with images if provided
  const messages: any[] = [{
    role: 'user',
    content: prompt
  }];
  
  if (request.images && request.images.length > 0) {
    // For models that support images, add them to the message
    messages[0].content = [
      { type: 'text', text: prompt },
      ...request.images.map(base64 => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg', // Could be detected from base64
          data: base64
        }
      }))
    ];
  }
  
  // Select appropriate model
  const modelId = await routeCreativeTask(request);
  
  // Call the LLM
  const response = await callLLM({
    model: modelId,
    messages,
    temperature: 0.8, // Higher for creativity
    maxTokens: 4000
  });
  
  // Determine content type
  let contentType: CreativeGenerationResponse['type'] = 'text';
  const content = response.content;
  
  if (content.includes('```') || content.includes('function') || content.includes('class')) {
    contentType = 'code';
  } else if (content.includes('{') && content.includes('}') && content.includes(':')) {
    contentType = 'structured';
  } else if (content.includes('```') && !content.match(/^```[\w+]*\n/)) {
    contentType = 'mixed';
  }
  
  return {
    content,
    type: contentType,
    metadata: {
      model: modelId,
      tokens: response.usage?.totalTokens,
      suggestions: extractSuggestions(content)
    }
  };
}

/**
 * Extract suggestions or variations from the generated content
 */
function extractSuggestions(content: string): string[] {
  const suggestions: string[] = [];
  
  // Look for bullet points that might be alternatives or suggestions
  const bulletPoints = content.match(/^[-*]\s+(.+)$/gm);
  if (bulletPoints && bulletPoints.length > 3) {
    // If there are many bullet points, they might be suggestions
    suggestions.push(...bulletPoints.slice(0, 3).map(bp => bp.replace(/^[-*]\s+/, '')));
  }
  
  // Look for "alternatively" or "another option" patterns
  const alternatives = content.match(/(?:alternatively|another option|you could also)[:\s]+([^.]+)/gi);
  if (alternatives) {
    suggestions.push(...alternatives.map(alt => alt.replace(/^(?:alternatively|another option|you could also)[:\s]+/i, '')));
  }
  
  return suggestions.slice(0, 5); // Limit to 5 suggestions
}