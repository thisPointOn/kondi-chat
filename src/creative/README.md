# Creative Generator Module

An interactive AI-powered image prompt generator that allows users to iteratively refine prompts through natural language.

## Features

- **Initial Generation**: Creates detailed image prompts from descriptions
- **Interactive Refinement**: Edit prompts using natural language instructions
- **Session Management**: Save and resume creative sessions
- **History Tracking**: Keep track of all edits and iterations

## Architecture

```
creative/
├── types.ts          # Type definitions
├── generator.ts      # Main generator & chat interface
├── prompt-builder.ts # AI prompt generation logic
├── session.ts        # Session persistence
└── example.ts        # Standalone example
```

## Usage

### Basic Example

```typescript
import { LLMCaller } from '../providers/llm-caller.ts';
import { CreativeGeneratorImpl, CreativeChat } from './generator.ts';

// Initialize
const llm = new LLMCaller();
const generator = new CreativeGeneratorImpl(llm);
const chat = new CreativeChat(generator);

// Start a creative session
const response = await chat.start({
  description: "A futuristic city at night",
  referenceUrl: "https://example.com/inspiration"
});

// Interactively edit
await chat.edit("Add flying cars and neon signs");
await chat.edit("Make it more cyberpunk style");
await chat.edit("Add rain and reflections");
```

### Interactive CLI Example

Run the standalone example:
```bash
npx tsx src/creative/example.ts
```

## Integration Points

### 1. CLI Integration

The creative generator can be integrated into the main kondi-chat CLI as a special mode:

```typescript
// Detect creative mode
if (message.startsWith('/creative')) {
  const description = message.slice(10).trim();
  const result = await creativeChat.start({ description });
  console.log(result);
  // Enter creative editing mode
}
```

### 2. Tool Integration

Add as a tool for the AI assistant:

```typescript
const creativeGeneratorTool = {
  name: 'generate_image_prompt',
  description: 'Generate and refine image generation prompts',
  parameters: {
    description: { type: 'string', required: true },
    referenceUrl: { type: 'string', required: false }
  },
  execute: async (params) => {
    const session = await generator.createSession(params);
    return session.currentPrompt;
  }
};
```

### 3. API Integration

Can be exposed as an API endpoint:

```typescript
app.post('/creative/start', async (req, res) => {
  const session = await generator.createSession(req.body);
  res.json(session);
});

app.post('/creative/:id/edit', async (req, res) => {
  const session = await generator.getSession(req.params.id);
  if (!session) return res.status(404).send('Session not found');
  
  const newPrompt = await generator.editPrompt(session, req.body.instruction);
  res.json(newPrompt);
});
```

## Prompt Engineering

The module uses specialized prompts for:

1. **Initial Generation**: Converts user descriptions into detailed image prompts
2. **Refinement**: Applies specific edits while preserving the core concept

## Session Files

Sessions are stored in `.kondi-chat/creative/` as JSON files:

```json
{
  "id": "uuid",
  "input": {
    "description": "User's original request",
    "referenceUrl": "https://..."
  },
  "currentPrompt": {
    "prompt": "Detailed image generation prompt",
    "style": "artistic style",
    "negativePrompt": "things to avoid"
  },
  "history": [
    {
      "instruction": "make it more dramatic",
      "previousPrompt": {...},
      "newPrompt": {...},
      "timestamp": "2024-01-20T..."
    }
  ]
}
```

## Best Practices

1. **Clear Instructions**: Be specific about what changes you want
2. **Iterative Refinement**: Make small, focused edits rather than complete rewrites
3. **Style Consistency**: Maintain consistent artistic style unless explicitly changing it
4. **Save Progress**: Sessions are automatically saved after each edit

## Future Enhancements

- [ ] Image analysis integration (analyze uploaded reference images)
- [ ] Multiple prompt variations
- [ ] Style presets and templates
- [ ] Batch processing
- [ ] Export to various image generation platforms