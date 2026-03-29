# Reex Manager LLM Training Guidelines

## 1) Goal

Build a company-specific manager model that behaves like a top leadership team for the CEO:
1. CEO Chief of Staff (priorities, execution order, blockers).
2. Sales Head (client selection, outreach scripts, follow-up cadence).
3. Product Head (market-fit decisions, feature priorities, launch timing).
4. Delivery Head (project risk, timeline confidence, mitigation actions).
5. Risk Manager (financial/operational risk scoring, contingency plans).

This model should give **actionable decisions**, not generic chat output.

## 2) Open-Source Model Strategy

Use OpenAI-compatible open-source serving so backend integration stays stable:
1. Serving layer: `Ollama` (fast local) or `vLLM` (production throughput).
2. Base model: start with an instruct model in the 7B-14B range.
3. Fine-tune method: LoRA/QLoRA SFT first, then preference tuning (DPO/ORPO) if needed.
4. Runtime route:
   - Primary: manager fine-tuned model.
   - Fallback 1: strong general instruct model.
   - Fallback 2: compact model for resilience.

## 3) Required Data (Company-Specific)

Train on your real operating decisions and outcomes:
1. Opportunity assessments (`opportunity-assessment`, `idea-validator-stream`).
2. Client acquisition assessments and follow-up outcomes.
3. Project health snapshots and intervention outcomes.
4. Weekly operating reviews and briefing decisions.
5. CRM activity logs (calls, replies, meetings, proposal status changes).

Avoid raw noisy dumps. Keep only examples with clear decision -> action -> result.

## 4) Training Data Schema

Store as JSONL for SFT:

```json
{"messages":[
  {"role":"system","content":"You are Reex Executive Manager. Return actionable manager guidance only."},
  {"role":"user","content":"Context: {kpis...}. Question: Which 3 clients should we target this week?"},
  {"role":"assistant","content":"Priority accounts: ...\nActions: ...\nRisks: ...\nConfidence: 78"}
],
"metadata":{"domain":"client-acquisition","quality":"high","outcome":"closed_won"}
}
```

Quality rules:
1. Assistant answer must include priorities, actions, risk note, and confidence.
2. Reject examples with vague language or no measurable next step.
3. Tag each record with domain (`sales`, `product`, `delivery`, `risk`, `ceo`).

## 5) Training Pipeline

### Stage A: Dataset Build
1. Export high-signal records from Reex logs and CRM.
2. Normalize into the JSONL schema.
3. Split: `train 80% / val 10% / test 10%`.

### Stage B: SFT (LoRA/QLoRA)
1. Train on manager-style responses.
2. Keep strict output format discipline.
3. Track validation loss + format adherence score.

### Stage C: Preference Tuning (Optional, recommended)
1. Create chosen/rejected pairs from your own decision style.
2. Tune for your leadership preference:
   - practical > theoretical
   - measurable > generic
   - low hallucination > creativity

### Stage D: Evaluation Gate
Model is accepted only if it passes:
1. Actionability score >= 85%.
2. Hallucination score <= 5%.
3. Correct priority ordering on holdout cases.
4. Better business proxy metrics than baseline prompt-only model.

## 6) Reex Integration Contract

For `/api/v1/intelligence/chat/stream`, model output must match:

```json
{
  "response": "string",
  "actions": ["string", "string"],
  "confidence": 0
}
```

Integration policy:
1. If LLM fails schema, use deterministic fallback.
2. Log every response with source (`live` vs `fallback`) and model name.
3. Keep full audit trail for retraining.

## 7) Deployment Profiles

### Local R&D
1. Serve with Ollama.
2. Use small/medium model for quick iteration.
3. Validate workflow behavior with real backend endpoints.

### Production
1. Serve primary model on vLLM.
2. Enable fallback models via `LLM_FALLBACK_MODELS`.
3. Add latency and failure SLO monitoring.

## 8) Retraining Cadence

1. Weekly: collect fresh decision/outcome pairs.
2. Biweekly: evaluate drift and run lightweight refresh training.
3. Monthly: full benchmark against previous production model.
4. Quarterly: architecture review (model size, serving infra, cost/performance).

## 9) Guardrails (Must Keep)

1. Never allow secret leakage in prompt or response.
2. Reject instruction injection from user-provided external content.
3. Constrain model output to manager-operational scope.
4. Preserve human override for all critical financial and legal actions.

## 10) Execution Checklist

1. Enable open-source model routing in backend env.
2. Collect and clean company decision datasets.
3. Run SFT baseline.
4. Evaluate on CEO-manager scenarios.
5. Deploy with fallback models.
6. Continuously retrain from real outcomes.

