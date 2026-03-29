from __future__ import annotations

import re
from typing import Any, Dict, Set


def _tokens(value: str) -> Set[str]:
    return {token for token in re.findall(r"[a-zA-Z0-9_]+", value.lower()) if len(token) >= 4}


def _overlap_ratio(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / max(len(a), 1)


def evaluate_marketing_assessment(project: str, trends: str, assessment: str) -> Dict[str, Any]:
    """
    Lightweight confidence evaluator inspired by RAGAS-style faithfulness/relevancy checks.
    """
    try:
        project_tokens = _tokens(project)
        trend_tokens = _tokens(trends)
        assessment_tokens = _tokens(assessment)

        relevance_project = _overlap_ratio(assessment_tokens, project_tokens)
        relevance_trends = _overlap_ratio(assessment_tokens, trend_tokens)

        actionability_hits = len(
            re.findall(
                r"\b(action|owner|metric|kpi|deadline|week|day|follow-up|pipeline|conversion|risk)\b",
                assessment.lower(),
            )
        )
        actionability_score = min(actionability_hits / 8.0, 1.0)

        fallback_penalty = 0.0
        if any(marker in assessment.lower() for marker in ["mock", "fallback", "error", "failed"]):
            fallback_penalty = 0.25

        confidence = (
            relevance_project * 0.35
            + relevance_trends * 0.35
            + actionability_score * 0.30
            - fallback_penalty
        )
        confidence = max(0.0, min(1.0, confidence))

        verdict = "PASS" if confidence >= 0.75 else "REVIEW" if confidence >= 0.55 else "LOW_CONFIDENCE"
        feedback = (
            f"{verdict}: relevance(project={relevance_project:.2f}, trends={relevance_trends:.2f}), "
            f"actionability={actionability_score:.2f}, penalty={fallback_penalty:.2f}."
        )

        return {"confidence_score": round(confidence, 4), "feedback": feedback}
    except Exception as exc:
        return {"confidence_score": 0.0, "feedback": f"Telemetry eval failed: {exc}"}
