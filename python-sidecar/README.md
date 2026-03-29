# Reex Helena Sidecar (Local Intelligence)

This sidecar runs Reex's local intelligence layer without external provider dependency for core behavior.

## What this sidecar does

1. `POST /agent/market-analyze`
   - Compares project context with market signals.
   - Produces actions and confidence using a local OpenAI-compatible model server.
2. `POST /agent/portfolio-strategy`
   - Synthesizes project-level assessments into 3 portfolio actions.
3. `POST /helena/suggest`
   - General executive manager suggestions (response + action list + confidence).
4. `POST /helena/forecast/predict`
   - Uses a saved classical forecasting model (`joblib`) for numeric prediction.

## Runtime architecture

1. `helena_runtime.py`
   - Calls local `/v1/chat/completions` endpoint (vLLM/Ollama gateway/TGI gateway).
   - Retries across fallback models.
   - Supports deterministic fallback when local model is unavailable.
2. `marketing_graph.py`
   - Analyzer -> Critic -> Evaluator loop for market intelligence outputs.
3. `ragas_evaluator.py`
   - Lightweight relevancy/actionability confidence scoring.
4. `helena_forecaster.py`
   - Classical prediction model training and inference.
5. `helena_trainer.py`
   - Dataset prep, SFT LoRA training, DPO training, and forecast training commands.

## Setup

1. Create venv and install runtime deps:

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

2. Optional training deps:

```bash
pip install -r requirements-training.txt
```

3. Run sidecar:

```bash
uvicorn main:app --reload --port 8000
```

## Environment variables

Required:

1. `SIDECAR_AUTH_TOKEN` - shared secret between backend and sidecar.

Local model runtime:

1. `HELENA_BASE_URL` (default: `http://127.0.0.1:8001/v1`)
2. `HELENA_MODEL` (default: `Qwen/Qwen3-8B`)
3. `HELENA_FALLBACK_MODELS` (comma-separated)
4. `HELENA_API_KEY` (optional; keep unset for local no-auth servers)
5. `HELENA_TIMEOUT_SECONDS` (default: `90`)
6. `HELENA_MOCK_IF_UNAVAILABLE` (default: `true`)

## Training workflow

1. Export datasets from backend:

```bash
cd backend
npm run export:manager-dataset
npm run export:manager-dpo-dataset
npm run export:forecast-dataset
```

2. Prepare SFT/DPO splits:

```bash
cd ../python-sidecar
python helena_trainer.py prepare --source ../backend/training/manager_sft.jsonl --output-dir training/processed
```

3. Train manager SFT LoRA:

```bash
python helena_trainer.py train-sft --base-model Qwen/Qwen3-8B --train-file training/processed/train.sft.jsonl --val-file training/processed/val.sft.jsonl --output-dir models/helena-sft
```

4. Train DPO preference model:

```bash
python helena_trainer.py train-dpo --model models/helena-sft --train-file training/processed/train.dpo.jsonl --output-dir models/helena-dpo
```

5. Train numeric forecaster:

```bash
python helena_trainer.py train-forecast --csv ../backend/training/forecast_features.csv --target target_next_week_wins --model-output models/helena_forecaster.joblib --metrics-output models/helena_forecaster_metrics.json
```
