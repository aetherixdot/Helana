from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests


def _as_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_fallback_models(value: str | None) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass
class HelenaRuntimeConfig:
    base_url: str = os.getenv("HELENA_BASE_URL", "http://127.0.0.1:8001/v1").rstrip("/")
    model: str = os.getenv("HELENA_MODEL", "Qwen/Qwen3-8B")
    fallback_models: List[str] = field(default_factory=lambda: _parse_fallback_models(os.getenv("HELENA_FALLBACK_MODELS")))
    api_key: Optional[str] = os.getenv("HELENA_API_KEY")
    timeout_seconds: float = float(os.getenv("HELENA_TIMEOUT_SECONDS", "90"))
    mock_when_unavailable: bool = _as_bool(os.getenv("HELENA_MOCK_IF_UNAVAILABLE"), default=True)


class HelenaRuntime:
    """
    Runtime wrapper for a local OpenAI-compatible model server (vLLM, Ollama gateway, etc.).
    """

    def __init__(self, config: Optional[HelenaRuntimeConfig] = None):
        self.config = config or HelenaRuntimeConfig()

    def _model_candidates(self, requested: Optional[str]) -> List[str]:
        primary = requested.strip() if requested else self.config.model
        return list(dict.fromkeys([primary, *self.config.fallback_models]))

    def _extract_json(self, raw_text: str) -> Dict[str, Any]:
        text = raw_text.strip()
        if not text:
            raise ValueError("Model returned empty content.")

        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        # Fallback: extract first JSON object from text.
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise ValueError("No JSON object found in model response.")
        parsed = json.loads(match.group(0))
        if not isinstance(parsed, dict):
            raise ValueError("Model JSON payload is not an object.")
        return parsed

    def _chat_completion(
        self,
        model: str,
        messages: List[Dict[str, str]],
        temperature: float,
        max_tokens: int,
    ) -> Dict[str, Any]:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.config.api_key and self.config.api_key != "not-configured":
            headers["Authorization"] = f"Bearer {self.config.api_key}"

        response = requests.post(
            f"{self.config.base_url}/chat/completions",
            headers=headers,
            json={
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            },
            timeout=self.config.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()

        choices = payload.get("choices", [])
        if not choices:
            raise ValueError("Model response is missing choices.")
        content = choices[0].get("message", {}).get("content", "")
        parsed = self._extract_json(content)
        parsed["_runtime_model"] = model
        return parsed

    def generate_json(
        self,
        system_prompt: str,
        user_payload: Dict[str, Any],
        fallback: Dict[str, Any],
        temperature: float = 0.2,
        max_tokens: int = 700,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        user_content = json.dumps(user_payload, ensure_ascii=True)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

        last_error: Optional[str] = None
        for candidate in self._model_candidates(model):
            try:
                return self._chat_completion(
                    model=candidate,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
            except Exception as exc:
                last_error = str(exc)
                continue

        if not self.config.mock_when_unavailable:
            raise RuntimeError(last_error or "Helena runtime failed for all models.")

        output = dict(fallback)
        output["_runtime_model"] = "local-fallback-mock"
        if last_error:
            output["_runtime_error"] = last_error
        return output
