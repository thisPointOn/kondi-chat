#!/usr/bin/env npx tsx
/**
 * Example: Interactive Creative Generator
 * 
 * This shows how to use the creative generator for interactive image prompt creation
 */

import { createInterface } from 'readline';
import { LLMCaller } from '../providers/llm-caller.ts';
import { CreativeGeneratorImpl, CreativeChat } from './generator.ts';

async function main() {
  // Initialize components
  const llm = new LLMCaller(); // This would use your configured model
  const generator = new CreativeGeneratorImpl(llm);
  const chat = new CreativeChat(generator);

  // Create readline interface
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('🎨 Creative Generator - Interactive Image Prompt Designer');
  console.log('=========================================================');
  
  // Get initial input
  const description = await new Promise<string>(resolve => {
    rl.question('\nDescribe what you want to create: ', resolve);
  });

  const referenceUrl = await new Promise<string>(resolve => {
    rl.question('Reference URL (optional, press Enter to skip): ', resolve);
  });

  // Start creative session
  const result = await chat.start({
    description,
    referenceUrl: referenceUrl || undefined
  });

  console.log('\n' + result);

  // Interactive editing loop
  console.log('\n📝 Now you can refine the prompt. Type "done" when satisfied.');
  
  while (true) {
    const instruction = await new Promise<string>(resolve => {
      rl.question('\nHow should I modify it? > ', resolve);
    });

    if (instruction.toLowerCase() === 'done') {
      break;
    }

    const updated = await chat.edit(instruction);
    console.log('\n' + updated);
  }

  // Save session ID for later
  console.log(`\n✅ Session saved! ID: ${chat.getSessionId()}`);
  console.log('You can resume this session later with: --session ' + chat.getSessionId());

  rl.close();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { main as runCreativeExample };