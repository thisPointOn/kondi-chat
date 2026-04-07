import { describe, it, expect, vi } from 'vitest';
import { CreativeGeneratorImpl, CreativeChat } from './generator.ts';
import { LLMCaller } from '../providers/llm-caller.ts';

// Mock LLMCaller
vi.mock('../providers/llm-caller.ts', () => ({
  LLMCaller: vi.fn().mockImplementation(() => ({
    call: vi.fn().mockImplementation((system, user) => {
      if (user.includes('Create an image generation prompt')) {
        return JSON.stringify({
          prompt: "A serene mountain landscape at sunset",
          style: "photorealistic",
          negativePrompt: "blurry, low quality"
        });
      }
      if (user.includes('make it more dramatic')) {
        return JSON.stringify({
          prompt: "A dramatic mountain landscape with storm clouds and lightning",
          style: "cinematic",
          negativePrompt: "blurry, low quality, calm"
        });
      }
      return "Updated prompt";
    })
  }))
}));

describe('CreativeGenerator', () => {
  it('should create a session with initial prompt', async () => {
    const llm = new LLMCaller();
    const generator = new CreativeGeneratorImpl(llm, '.test-creative');
    
    const session = await generator.createSession({
      description: 'A mountain scene'
    });

    expect(session.id).toBeTruthy();
    expect(session.currentPrompt.prompt).toContain('mountain landscape');
    expect(session.currentPrompt.style).toBe('photorealistic');
  });

  it('should edit prompts based on instructions', async () => {
    const llm = new LLMCaller();
    const generator = new CreativeGeneratorImpl(llm, '.test-creative');
    
    const session = await generator.createSession({
      description: 'A mountain scene'
    });

    const edited = await generator.editPrompt(session, 'make it more dramatic');
    
    expect(edited.prompt).toContain('dramatic');
    expect(edited.prompt).toContain('storm clouds');
    expect(session.history).toHaveLength(1);
  });
});

describe('CreativeChat', () => {
  it('should provide user-friendly interface', async () => {
    const llm = new LLMCaller();
    const generator = new CreativeGeneratorImpl(llm, '.test-creative');
    const chat = new CreativeChat(generator);

    const response = await chat.start({
      description: 'A peaceful forest'
    });

    expect(response).toContain('Creative session started');
    expect(response).toContain('Generated Image Prompt');
    expect(response).toContain('mountain landscape');
  });

  it('should handle edits through chat interface', async () => {
    const llm = new LLMCaller();
    const generator = new CreativeGeneratorImpl(llm, '.test-creative');
    const chat = new CreativeChat(generator);

    await chat.start({
      description: 'A peaceful forest'
    });

    const editResponse = await chat.edit('make it more dramatic');
    
    expect(editResponse).toContain('Updated Image Prompt');
    expect(editResponse).toContain('Edit applied');
    expect(editResponse).toContain('Total edits: 1');
  });
});