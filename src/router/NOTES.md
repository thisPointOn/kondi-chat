# Router Design Notes

## From NVIDIA LLM Router v2 (vendor/llm-router)

### Threshold Tuning Analysis
The NVIDIA codebase (`nn_router.py:401-496`) has a systematic threshold tuning
approach worth replicating as a `/routing tune` command:

- Tests multiple confidence threshold configurations per model
- Measures accuracy vs cost savings tradeoff for each config
- Uses relative cost weights (frontier=1.0, mid=0.4, cheap=0.1)
- Outputs a table: threshold config → accuracy, model selection %, cost savings %
- Recommends configurations at different aggressiveness levels

This should be built when we have enough training data to evaluate.

### Intent-Based Routing (for cold-start)
The NVIDIA intent router (`hf_intent_objective_fn.py:53-77`) uses a prompt template
where model/route descriptions are embedded as XML, and a small LLM classifies
which route matches the user's intent. This solves the cold-start problem when a
new model is added but the NN hasn't been trained on it yet.

We adapted this as `src/router/intent-router.ts`.

## Three-Tier Routing Architecture
1. **NN Router** — fast, trained, handles known patterns (primary once trained)
2. **Intent Router** — LLM classifies prompt against model descriptions (cold-start)
3. **Rule Router** — phase/task-kind fallback (always available)
