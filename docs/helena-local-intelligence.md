# Helena Local Intelligence Blueprint

## Goal

Build Reex core intelligence with local open-weight models and internal data loops, so production does not depend on external paid LLM provider APIs.

## Core design

1. Local reasoning model:
   - OpenAI-compatible local serving endpoint (`/v1/chat/completions`) via vLLM/Ollama gateway/TGI gateway.
2. Supervised adaptation:
   - LoRA SFT on exported manager decision traces.
3. Preference alignment:
   - DPO on chosen vs rejected responses generated from real logs.
4. Prediction engine:
   - Separate classical forecasting model for numeric outcomes (pipeline/demand wins).
5. Daily autonomous loop:
   - Export fresh data -> retrain/evaluate -> promote model only when quality thresholds pass.

## Why hybrid (LLM + forecaster)

1. LLM:
   - Strategy synthesis, next-action generation, narrative reasoning.
2. Forecaster:
   - Stable numeric prediction for trend direction and planning confidence.

## Research references used

1. Chinchilla scaling laws (compute-optimal training):
   - https://arxiv.org/abs/2203.15556
2. LoRA:
   - https://arxiv.org/abs/2106.09685
3. QLoRA:
   - https://arxiv.org/abs/2305.14314
4. DPO:
   - https://arxiv.org/abs/2305.18290
5. RAG baseline paper:
   - https://arxiv.org/abs/2005.11401
6. vLLM OpenAI-compatible serving:
   - https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
7. PEFT docs:
   - https://huggingface.co/docs/peft/index
8. TRL docs:
   - https://huggingface.co/docs/trl/index
