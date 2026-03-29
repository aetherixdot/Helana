from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List

from helena_runtime import HelenaRuntime
from ragas_evaluator import evaluate_marketing_assessment

runtime = HelenaRuntime()


def _default_assessment(project_context: Dict[str, Any], market_signals: str) -> str:
    project_name = str(project_context.get("name") or "Unnamed project")
    domain = str(project_context.get("domain") or "general market")
    return (
        f"Project '{project_name}' in {domain}: prioritize one fast outbound experiment and one product proof asset. "
        "Action 1: publish one quantified case-study style post aligned to strongest trend cluster this week. "
        "Action 2: run a 5-account outreach sprint using pain-point language from current market signals. "
        "Metric: qualified conversations booked in 7 days."
    )


@dataclass
class MarketingState:
    project_context: Dict[str, Any]
    market_signals: str
    assessment: str = ""
    critique_count: int = 0
    is_valid: bool = False
    confidence_score: float = 0.0
    evaluation_feedback: str = ""
    actions: List[str] | None = None
    runtime_model: str = "unknown"


def analyzer_node(state: MarketingState) -> MarketingState:
    fallback_assessment = _default_assessment(state.project_context, state.market_signals)
    payload = {
        "task": "Compare project data with market signals and produce concrete marketing actions.",
        "projectContext": state.project_context,
        "marketSignals": state.market_signals,
        "mustHave": [
            "No generic advice",
            "Include measurable KPI",
            "Include 7-day action window",
            "Mention one risk guardrail",
        ],
    }
    system_prompt = (
        "You are Helena, Reex's autonomous growth strategist. "
        "Return strict JSON with keys: assessment, actions, confidence."
    )
    result = runtime.generate_json(
        system_prompt=system_prompt,
        user_payload=payload,
        fallback={
            "assessment": fallback_assessment,
            "actions": [
                "Publish one case-study-led outbound post in the top active channel.",
                "Run follow-up cadence for 5 high-fit accounts within 48 hours.",
            ],
            "confidence": 0.58,
        },
        temperature=0.2,
        max_tokens=700,
    )

    state.assessment = str(result.get("assessment") or fallback_assessment)
    state.actions = [
        str(item).strip()
        for item in (result.get("actions") if isinstance(result.get("actions"), list) else [])
        if str(item).strip()
    ][:4]
    state.runtime_model = str(result.get("_runtime_model", "unknown"))
    return state


def critic_node(state: MarketingState) -> MarketingState:
    payload = {
        "assessment": state.assessment,
        "rules": [
            "Specific to provided context",
            "Contains at least one measurable metric",
            "Contains explicit next actions",
            "Avoids fabricated external facts",
        ],
    }
    critic_result = runtime.generate_json(
        system_prompt=(
            "You are Helena QA critic. Return strict JSON with keys: valid, reasons, rewrite. "
            "If invalid, provide rewrite text."
        ),
        user_payload=payload,
        fallback={
            "valid": len(state.assessment) > 140 and ("metric" in state.assessment.lower() or "kpi" in state.assessment.lower()),
            "reasons": ["Fallback critic used."],
            "rewrite": state.assessment,
        },
        temperature=0.05,
        max_tokens=450,
    )

    state.critique_count += 1
    state.is_valid = bool(critic_result.get("valid"))
    rewrite = critic_result.get("rewrite")
    if not state.is_valid and isinstance(rewrite, str) and len(rewrite.strip()) > 80:
        state.assessment = rewrite.strip()
    return state


def evaluator_node(state: MarketingState) -> MarketingState:
    eval_result = evaluate_marketing_assessment(
        project=str(state.project_context),
        trends=state.market_signals,
        assessment=state.assessment,
    )
    state.confidence_score = float(eval_result["confidence_score"])
    state.evaluation_feedback = str(eval_result["feedback"])
    return state


def run_marketing_graph(project_context: Dict[str, Any], market_signals: str) -> Dict[str, Any]:
    state = MarketingState(
        project_context=project_context or {},
        market_signals=market_signals or "No trends provided.",
    )

    state = analyzer_node(state)
    for _ in range(2):
        state = critic_node(state)
        if state.is_valid:
            break
        state = analyzer_node(state)

    state = evaluator_node(state)
    return {
        "assessment": state.assessment,
        "actions": state.actions or [],
        "critiques_required": state.critique_count,
        "passed_qa": state.is_valid,
        "confidence": state.confidence_score,
        "telemetry_feedback": state.evaluation_feedback,
        "runtime_model": state.runtime_model,
    }
