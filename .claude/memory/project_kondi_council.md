---
name: kondi-council integration plan
description: Plan to optimize kondi-council costs and integrate as a tool in kondi-chat with configurable council profiles
type: project
---

## kondi-council cost optimization (do first, in the council repo)

1. Populate `cacheableContext` with bootstrap directory — field exists, just never set
2. Remove summarization fallback to full entries — always use mechanical summary
3. Add streaming + lower max_tokens (2K consultants, 4K workers)
4. Add early consensus exit when manager confidence > 0.9

**Why:** 35-65% cost reduction. A 3-round deliberation goes from ~135K tokens to ~50-90K.

## Integration into kondi-chat

- Add `run_council` tool that shells out to kondi-council CLI with `--json-stdout`
- Council profiles stored in `.kondi-chat/councils/` as JSON configs
- Presets: coding-cheap, coding-quality, analysis, debate, security-review
- /council command to list, run, and manage profiles
- Council manages its own context — chat just passes a brief + relevant files

**How to apply:** The council optimizations happen in /home/erik/Documents/kondi-council. The integration tool is added to kondi-chat.
