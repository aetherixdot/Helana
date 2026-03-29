from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        payload = json.loads(stripped)
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def _extract_assistant_text(record: Dict[str, Any]) -> str:
    messages = record.get("messages")
    if not isinstance(messages, list):
        return ""
    for item in reversed(messages):
        if not isinstance(item, dict):
            continue
        if item.get("role") == "assistant" and isinstance(item.get("content"), str):
            return item["content"]
    return ""


def optimize_prompt(dataset_path: Path, output_path: Path) -> Dict[str, Any]:
    records = _read_jsonl(dataset_path)
    if len(records) < 8:
        raise ValueError("Need at least 8 records to build a stable prompt profile.")

    action_keywords = Counter()
    metric_keywords = Counter()
    for record in records:
        text = _extract_assistant_text(record).lower()
        for token in ["owner", "kpi", "metric", "risk", "timeline", "deadline", "follow-up", "pipeline", "conversion"]:
            if token in text:
                action_keywords[token] += 1
        for token in ["%", "week", "days", "hours"]:
            if token in text:
                metric_keywords[token] += 1

    output = {
        "version": "helena-marketing-prompt-v1",
        "dataset_size": len(records),
        "system_prompt": (
            "You are Helena, Reex's autonomous manager. "
            "Return concise, measurable actions with owners, timelines, risks, and KPI targets."
        ),
        "must_include": [
            "3 prioritized actions",
            "named owner for each action",
            "7-day measurable KPI",
            "one explicit risk guardrail",
        ],
        "learned_signal_frequency": {
            "action_keywords": action_keywords.most_common(),
            "metric_markers": metric_keywords.most_common(),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Build prompt profile from Reex manager dataset.")
    parser.add_argument("--dataset", default="training/manager_sft.jsonl", help="Input SFT JSONL path.")
    parser.add_argument(
        "--output",
        default="training/optimized_marketing_prompt.json",
        help="Output optimized prompt JSON path.",
    )
    args = parser.parse_args()

    result = optimize_prompt(Path(args.dataset), Path(args.output))
    print(f"Saved optimized prompt profile to {args.output}.")
    print(f"Records processed: {result['dataset_size']}")


if __name__ == "__main__":
    main()
