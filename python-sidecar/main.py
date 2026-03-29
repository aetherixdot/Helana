from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from helena_forecaster import predict_with_saved_model
from helena_runtime import HelenaRuntime
from marketing_graph import run_marketing_graph

load_dotenv()

app = FastAPI(title="Reex Helena Sidecar", version="5.0.0")
runtime = HelenaRuntime()


class AgentContext(BaseModel):
    query: str
    project_context: Optional[Dict[str, Any]] = None
    market_signals: Optional[List[Dict[str, str]]] = None


class AgentResponse(BaseModel):
    status: str
    output: Dict[str, Any]


class HelenaSuggestRequest(BaseModel):
    message: str = Field(min_length=3, max_length=5000)
    context: Dict[str, Any] = Field(default_factory=dict)


class ForecastPredictRequest(BaseModel):
    model_path: str = "models/helena_forecaster.joblib"
    row: Dict[str, float]


class HelenaPrecisionAnalyzeRequest(BaseModel):
    telemetry: Dict[str, Any]
    lowConfidenceSamples: List[Dict[str, Any]] = Field(default_factory=list)
    failedSamples: List[Dict[str, Any]] = Field(default_factory=list)
    recentSamples: List[Dict[str, Any]] = Field(default_factory=list)
    constraints: List[str] = Field(default_factory=list)


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    return {
        "status": "ok",
        "service": "Reex Helena Sidecar",
        "mode": "local-open-source",
        "model": runtime.config.model,
        "base_url": runtime.config.base_url,
    }


security = HTTPBearer()
SIDECAR_SECRET = os.getenv("SIDECAR_AUTH_TOKEN", "reex-internal-sidecar-token-v4")


def verify_token(credentials: HTTPAuthorizationCredentials = Security(security)) -> bool:
    if credentials.credentials != SIDECAR_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing SIDECAR_AUTH_TOKEN")
    return True


@app.post("/agent/market-analyze", response_model=AgentResponse, dependencies=[Depends(verify_token)])
async def analyze_market(context: AgentContext) -> AgentResponse:
    try:
        trend_text = str(context.market_signals) if context.market_signals else "No trends provided."
        graph_output = run_marketing_graph(context.project_context or {}, trend_text)
        return AgentResponse(status="success", output=graph_output)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/agent/portfolio-strategy", response_model=AgentResponse, dependencies=[Depends(verify_token)])
async def portfolio_strategy(context: AgentContext) -> AgentResponse:
    try:
        assessments = context.project_context.get("individualAssessmentsText", "") if context.project_context else ""
        prompt_payload = {
            "task": "Synthesize portfolio strategy from project-level market assessments.",
            "requirements": [
                "Return exactly 3 prioritized actions.",
                "Each action must include owner and 7-day outcome metric.",
                "Keep advice specific to provided assessments only.",
            ],
            "assessmentsText": assessments,
        }
        system_prompt = (
            "You are Helena, Reex's autonomous operating strategist. "
            "Output strict JSON with keys: strategy, actions, confidence."
        )
        fallback = {
            "strategy": "Focus resources on top two projects with strongest demand signals.",
            "actions": [
                "Owner: CEO - Reallocate 20% weekly capacity to highest-confidence project.",
                "Owner: Sales - Schedule 5 TAKE_NOW account calls using strongest case-study proof.",
                "Owner: Delivery - Resolve top 3 quality risks blocking conversion confidence.",
            ],
            "confidence": 0.62,
        }
        output = runtime.generate_json(
            system_prompt=system_prompt,
            user_payload=prompt_payload,
            fallback=fallback,
            temperature=0.15,
            max_tokens=700,
        )
        return AgentResponse(status="success", output=output)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/helena/suggest", response_model=AgentResponse, dependencies=[Depends(verify_token)])
async def helena_suggest(payload: HelenaSuggestRequest) -> AgentResponse:
    try:
        response = runtime.generate_json(
            system_prompt=(
                "You are Helena, Reex's executive operating AI. "
                "Return strict JSON with keys: response, actions, confidence."
            ),
            user_payload={
                "message": payload.message,
                "context": payload.context,
                "constraints": [
                    "Action-oriented guidance only.",
                    "Avoid generic advice.",
                    "Include measurable next steps.",
                ],
            },
            fallback={
                "response": "Focus on one revenue action and one delivery-risk action today.",
                "actions": [
                    "Run client fit scoring on top 5 pipeline accounts.",
                    "Close highest-severity delivery blocker before end of day.",
                ],
                "confidence": 0.58,
            },
            temperature=0.2,
            max_tokens=850,
        )
        return AgentResponse(status="success", output=response)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/helena/forecast/predict", response_model=AgentResponse, dependencies=[Depends(verify_token)])
async def helena_forecast_predict(payload: ForecastPredictRequest) -> AgentResponse:
    try:
        prediction = predict_with_saved_model(payload.model_path, payload.row)
        return AgentResponse(status="success", output=prediction)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/helena/precision/analyze", response_model=AgentResponse, dependencies=[Depends(verify_token)])
async def helena_precision_analyze(payload: HelenaPrecisionAnalyzeRequest) -> AgentResponse:
    try:
        response = runtime.generate_json(
            system_prompt=(
                "You are Helena Precision Analyst for Reex Intelligence. "
                "Analyze telemetry and return strict JSON with keys: "
                "analysisSummary, weaknessClusters, retrainingPlan, evaluationPlan, confidence, provenance."
            ),
            user_payload={
                "telemetry": payload.telemetry,
                "lowConfidenceSamples": payload.lowConfidenceSamples,
                "failedSamples": payload.failedSamples,
                "recentSamples": payload.recentSamples,
                "constraints": payload.constraints
                or [
                    "Prioritize precision and factual correctness.",
                    "Recommend only executable local-stack improvements.",
                    "Provide measurable retraining targets.",
                ],
            },
            fallback={
                "analysisSummary": "Telemetry indicates precision can improve by focusing on low-confidence and failed paths.",
                "weaknessClusters": [
                    "Confidence calibration drift across workflows",
                    "Sparse failure-to-fix preference pairs",
                    "Insufficient outcome-linked supervision data",
                ],
                "retrainingPlan": {
                    "sftExamplesTarget": 1200,
                    "dpoPairsTarget": 240,
                    "datasetActions": [
                        "Label top failed/low-confidence samples each week.",
                        "Generate DPO pairs from accepted versus rejected manager actions.",
                        "Replay high-impact prompts as a fixed evaluation set.",
                    ],
                },
                "evaluationPlan": [
                    "Track faithfulness and answer relevance on a fixed replay set.",
                    "Compare confidence calibration before and after retraining.",
                    "Block promotion if precision metrics regress.",
                ],
                "confidence": 0.63,
                "provenance": {
                    "source": "mixed",
                    "retrievedAt": "runtime-generated",
                    "gaps": ["Fallback synthesis used due to model availability."],
                },
            },
            temperature=0.1,
            max_tokens=1100,
        )
        return AgentResponse(status="success", output=response)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
