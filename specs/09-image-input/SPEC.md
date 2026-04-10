# 09 — Image Input

## Product Description

Image Input lets users include images in their chat messages by referencing file paths. The TUI reads the images, base64-encodes them, and sends them in the submit command. The backend automatically routes messages containing images to vision-capable models (Claude Sonnet, GPT-4o, Gemini 2.5) and passes images through to those models' vision APIs. Supported formats: PNG, JPG, GIF, WebP, and PDF (first page rasterized).

**Why it matters:** Screenshots are a huge part of debugging and design workflows. "Look at this error" with an attached screenshot is dramatically more efficient than describing the error in words. Design review, diagram analysis, and visual debugging all require image support.

**Revised 2026-04-10 (simplification pass):** Dropped downscaling (10 MB cap is enforcement; let the model handle large images or error out). Dropped PDF rasterization and bare-filename auto-detect — v1 requires `/attach <path>` or an explicit path regex. Dropped `imageRefs` hash cache (images are ephemeral — after each turn, drop from history). Dropped the images config block in favor of constants. PDF story moved to a "Future work" note. Effort dropped from 4 days to 1.5 days.

## User Stories

1. **Error screenshot:** The user drags a screenshot of a compiler error into the TUI (or types `look at ./screenshot.png`). The TUI detects the image path, reads and encodes it, and sends it to the backend. The router picks Claude Sonnet (vision-capable) and the agent describes the error and suggests a fix.

2. **UI review:** The user has a Figma export at `designs/login.png` and asks "implement this login page." The agent sees the image, extracts the layout and colors, and writes React code that matches.

3. **PDF analysis:** The user references `spec.pdf` in their message. The TUI rasterizes the first page of the PDF to a PNG, sends it as an image, and the agent reads the spec content via vision.

4. **Multiple images:** The user pastes three screenshots showing a bug across three screens. All three are sent to the model in one message. The agent compares them and identifies the bug.

5. **Vision routing override:** The user adds `@claude look at screenshot.png` to force Claude. The router respects the @mention, and Claude gets the image. If they @mention a non-vision model (e.g., `@deepseek`), the backend warns "deepseek does not support images, falling back to claude."

## Clarifications (2026-04-10)

- **Routing precedence:** If the user @mentions a model and it supports vision, use it. If they @mention a non-vision model, fail with a clear error unless `allowVisionFallback` is true; in that case pick the first vision-capable model and state the swap. No silent reroute.
- **Attachment semantics:** Only attach paths explicitly referenced (`/attach` or regex match) in the current message. Do not auto-attach bare filenames unless wrapped in `/attach` to avoid accidental capture. Preserve text/image order by sending a single message with interleaved parts where the provider supports it; otherwise send all images after text.
- **PDF handling:** Choose one implementation path: rasterize via `pdfium-render` (with pdfium dep); if pdfium missing, return an actionable error. Drop the “pure Rust” requirement or supply an alternative backend; do not mention `pdf-parse` unless it is wired.
- **Provider payload:** Define ordering: send images in the order they appear in the message; preserve multiple images. Animated GIFs are treated as static (first frame). For PDF raster, send the rendered PNG with `mime: image/png`.
- **Limits:** Per-image 10 MB and max 5 images per message; enforce and error clearly when exceeded.
## Technical Design

### Architecture

```
User input with image path
        │
        v
  TUI: detect image paths in input (regex, explicit @image, drag-drop)
  TUI: read file, base64 encode, MIME detect
        │
        v
  TuiCommand::Submit { text, images: [ImageAttachment] }
        │
        v
  Backend: detect images in request
  Route to vision-capable model (filter registry by capability 'vision')
        │
        v
  LLMRequest: include images in message parts
        │
        v
  Provider adapter: format images per provider API
```

### Image path detection in TUI

The TUI scans user input for:
1. **Explicit paths** matching `(?:\./|/|~/)[\w\-./]+\.(png|jpg|jpeg|gif|webp)` (case-insensitive) — only anchored (leading `./`, `/`, or `~/`), never bare filenames.
2. **Explicit attach:** `/attach <path>` slash command.

Only existing files are attached. Missing paths are left as text. **Revised:** dropped bare-filename auto-detect and drag-and-drop capture — both invite accidental attachment. `/attach` is the opt-in path.

### Image encoding

- PNG, JPG, GIF, WebP: Read file, base64-encode, determine MIME type from magic bytes.
- Max file size: 10 MB per image (constant). Larger files rejected with error.
- Max total images per message: 5 (constant).
- **PDF support: deferred to v2.** Users convert PDFs to PNG manually. Rasterization required a native dep; not worth it for v1.
- **Downscaling: deferred to v2.** Provider APIs handle downscaling; if they don't, users can downscale manually.

### Capability integration

The existing `ModelRegistry` in `src/router/registry.ts` already stores `capabilities: ModelCapability[]` as open-ended strings. Adding `vision` is just tagging known models:

```yaml
# In .kondi-chat/models.yml (or default DEFAULT_MODELS in registry.ts):
- id: claude-sonnet-4-5-20250929
  capabilities: [coding, reasoning, vision]
```

No new type or schema change. The router's rule layer adds a filter: if `hasImages`, limit candidates to `m.capabilities.includes('vision')`.

### Model selection

Add a `vision` capability to the model registry. Vision-capable models are pre-tagged:

```yaml
- id: claude-sonnet-4-5-20250929
  capabilities: [coding, reasoning, vision]
- id: gpt-4o
  capabilities: [general, vision]
- id: models/gemini-2.5-flash
  capabilities: [general, fast, vision]
```

When a submit contains images, the router prioritizes models with the `vision` capability. If the active model doesn't support vision, the router transparently swaps to the best vision-capable model and notes this in the decision reason ("auto-swapped to claude-sonnet for vision").

### Provider adapters

Each provider has a different image format:

- **Anthropic**: `{ type: "image", source: { type: "base64", media_type, data } }` inside content array
- **OpenAI**: `{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }` inside content array
- **Google Gemini**: `{ inline_data: { mime_type, data } }` inside parts array

The abstraction lives in `src/providers/llm-caller.ts` via a new `ImagePart` type in `LLMMessage.content`.

## Implementation Details

### New types

**`src/types.ts`** — Add image support to messages:

```typescript
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string };

export interface LLMMessage {
  role: 'user' | 'assistant' | 'tool';
  /** For simple text messages */
  content?: string;
  /** For messages with images, use parts instead of content */
  parts?: ContentPart[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ImageAttachment {
  mimeType: string;
  base64: string;
  originalPath?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}
```

### New files

**`src/engine/images.ts`**

```typescript
import { readFileSync, existsSync, statSync } from 'node:fs';
import type { ImageAttachment } from '../types.ts';

export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 5;

/** Detect MIME type from magic bytes (not extension) */
export function detectMimeType(buffer: Buffer): string | null;

/** Load an image file, returning a base64-encoded attachment */
export function loadImageFromPath(path: string): ImageAttachment;
```

No downscaling, no PDF rasterization, no path extraction (TUI-side regex). Three exported symbols; ~60 lines total.

### Modified files

**`src/providers/llm-caller.ts`** — Update each provider adapter to support images:

```typescript
// Anthropic adapter:
function anthropicFormatMessage(msg: LLMMessage) {
  if (msg.parts) {
    return {
      role: msg.role,
      content: msg.parts.map(p =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.base64 } }
      ),
    };
  }
  return { role: msg.role, content: msg.content };
}

// OpenAI adapter:
function openaiFormatMessage(msg: LLMMessage) {
  if (msg.parts) {
    return {
      role: msg.role,
      content: msg.parts.map(p =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } }
      ),
    };
  }
  return { role: msg.role, content: msg.content };
}
```

**`src/router/index.ts` + `src/router/rules.ts`** — Prefer vision-capable models when images present.

**Revised:** the unified `Router.select(phase, promptText, taskKind, failures, promotionThreshold)` signature (see `src/router/index.ts`) has no `hasImages` parameter today, and neither does the inner `RuleRouter.select`. Adding vision filtering requires:

1. Extend `Router.select(..., opts?: { hasImages?: boolean })` to accept the flag.
2. At the top of `select`, if `hasImages`, filter the registry view to vision-capable models *before* any tier runs — NN and Intent routers would otherwise rank non-vision models. The cheapest correct implementation is a short-circuit that skips NN/Intent and selects directly from the vision-capable subset using the rule router with a filtered registry view.
3. The @mention path in `backend.ts` (`router.registry.getByAlias`) must also check `hasImages` and fail per the 2026-04-10 clarification ("no silent reroute"):

```typescript
// In handleSubmit @mention branch:
if (images.length > 0 && !targetModel.capabilities.includes('vision')) {
  emit({ type: 'error', message: `@${alias} has no vision capability; use a vision-capable model or drop the image.` });
  return;
}
```

4. Throwing from `rules.select()` breaks the existing "rules always succeed" contract (Router.select relies on it as the ultimate fallback). Instead, return an empty decision or raise in the outer `Router.select` wrapper, not inside `RuleRouter`.

**`src/cli/backend.ts`** — Handle images in submit:

```typescript
if (cmd.type === 'submit') {
  const images = cmd.images || [];
  await handleSubmit(cmd.text, images, session, ...);
}

async function handleSubmit(input: string, images: ImageAttachment[], ...) {
  contextManager.addUserMessage(input, images);
  // Build LLMMessage with parts if images present
  const parts: ContentPart[] = [
    { type: 'text', text: userMessage },
    ...images.map(img => ({ type: 'image' as const, mimeType: img.mimeType, base64: img.base64 })),
  ];
  const messages: LLMMessage[] = [{ role: 'user', parts }];
  // ... rest of loop ...
}
```

**`tui/src/app.rs`** and **`tui/src/protocol.rs`** — Add image support:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub mime_type: String,
    pub base64: String,
    pub original_path: Option<String>,
    pub size_bytes: u64,
}

// In TuiCommand::Submit:
#[serde(rename = "submit")]
Submit {
    text: String,
    #[serde(default)]
    images: Vec<ImageAttachment>,
},
```

**`tui/src/main.rs`** — Add image detection and loading in submit handler:

```rust
fn detect_and_load_images(text: &str, working_dir: &Path) -> Vec<ImageAttachment> {
    // Scan text for image paths, read files, encode to base64
}
```

### Context manager update

`contextManager.addUserMessage(input, images?)` accepts an optional images array. Images are only sent on the turn they were attached — on compaction they are dropped from history (the model has already seen them once). No image cache, no hash-ref indirection. **Revised:** imageRefs + imageCache deleted.

## Protocol Changes

### Modified `Submit` command

```rust
#[serde(rename = "submit")]
Submit {
    text: String,
    #[serde(default)]
    images: Vec<ImageAttachment>,
},
```

### New command: `/attach`

```json
{ "type": "command", "text": "/attach ./screenshot.png" }
```

Adds the image to the pending message before the next submit.

## Configuration

No config. All values are constants in `src/engine/images.ts`.

## Error Handling

| Scenario | Handling |
|----------|----------|
| File not found | Silently skip (probably just text mentioning a filename) |
| File too large | Error: "Image exceeds 10MB limit: <path>" |
| Unsupported format | Error with list of supported formats |
| PDF rasterization unavailable | Error: "PDF rasterization requires pdfium; install or convert manually" |
| No vision-capable model available | Error: "No vision model available. Enable gpt-4o or claude-sonnet." |
| Downscale fails | Send original (may be slow, may exceed model limits) |
| Invalid base64 from TUI | Error: "Corrupted image data" |
| Image in context after compaction | Remove from history; only the most recent 1-2 images retained to save tokens |

## Testing Plan

1. **Unit tests** (`src/engine/images.test.ts`):
   - MIME detection from magic bytes for each format
   - `extractImagePaths()` finds paths in various text formats
   - `loadImageFromPath()` produces valid attachment
   - Size and dimension limits enforced

2. **Integration tests**:
   - Full submit with image -> vision-capable model selected
   - Provider adapters format correctly for each provider
   - Router fallback to vision model when active model isn't vision-capable

3. **E2E tests**:
   - TUI detects image in typed message
   - Image reaches the LLM and gets a sensible response
   - `/attach` command works

## Dependencies

- **Depends on:** `src/providers/llm-caller.ts` (provider formatting), `src/router/registry.ts` (capability filtering), `src/context/manager.ts` (image-aware messages)
- **Depended on by:** Spec 07 (Sub-agents — research sub-agents can use images), Spec 10 (Non-interactive — CLI images via `--image` flag)
- **External (optional):** PDF rasterization library (Rust: `pdfium-render`; Node fallback: `pdf-parse` for text-only)

## Estimated Effort

**1.5 days** (revised from 4 days)
- Day 1: `images.ts` (loadImageFromPath, magic-byte MIME), provider adapter updates (Anthropic/OpenAI/Gemini), router vision filter, `/attach` command.
- Day 2 morning: TUI path regex, protocol `Submit.images`, smoke test with one vision model.
