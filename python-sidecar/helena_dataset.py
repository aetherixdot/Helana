from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple


@dataclass
class DatasetSplitSummary:
    train_count: int
    val_count: int
    test_count: int
    output_dir: str


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


def _write_jsonl(path: Path, rows: Iterable[Dict[str, Any]]) -> int:
    data = [json.dumps(row, ensure_ascii=True) for row in rows]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(data) + ("\n" if data else ""), encoding="utf-8")
    return len(data)


def split_sft_dataset(
    source_jsonl: str,
    output_dir: str,
    seed: int = 42,
    val_ratio: float = 0.1,
    test_ratio: float = 0.1,
) -> DatasetSplitSummary:
    source_path = Path(source_jsonl)
    out_dir = Path(output_dir)
    rows = _read_jsonl(source_path)
    if len(rows) < 10:
        raise ValueError("Need at least 10 rows for SFT split.")

    rng = random.Random(seed)
    rng.shuffle(rows)

    val_count = max(1, int(len(rows) * val_ratio))
    test_count = max(1, int(len(rows) * test_ratio))
    train_count = len(rows) - val_count - test_count
    if train_count <= 0:
        raise ValueError("Dataset too small after split ratios.")

    train_rows = rows[:train_count]
    val_rows = rows[train_count : train_count + val_count]
    test_rows = rows[train_count + val_count :]

    _write_jsonl(out_dir / "train.sft.jsonl", train_rows)
    _write_jsonl(out_dir / "val.sft.jsonl", val_rows)
    _write_jsonl(out_dir / "test.sft.jsonl", test_rows)

    return DatasetSplitSummary(
        train_count=len(train_rows),
        val_count=len(val_rows),
        test_count=len(test_rows),
        output_dir=str(out_dir),
    )


def _extract_messages(record: Dict[str, Any]) -> Tuple[str, str]:
    messages = record.get("messages")
    if not isinstance(messages, list):
        return "", ""

    prompt = ""
    answer = ""
    for item in messages:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if not isinstance(content, str):
            continue
        if role == "user" and not prompt:
            prompt = content.strip()
        if role == "assistant":
            answer = content.strip()
    return prompt, answer


def _score_record(record: Dict[str, Any], answer: str) -> float:
    metadata = record.get("metadata")
    score = 0.0
    if isinstance(metadata, dict):
        quality = str(metadata.get("quality", "")).lower()
        if quality in {"high", "gold", "accepted"}:
            score += 1.5
        outcome = str(metadata.get("outcome", "")).lower()
        if any(tag in outcome for tag in ("won", "success", "completed")):
            score += 1.5
    if "kpi" in answer.lower() or "metric" in answer.lower():
        score += 0.6
    if len(answer) >= 160:
        score += 0.4
    return score


def build_dpo_pairs(source_jsonl: str, output_jsonl: str) -> int:
    rows = _read_jsonl(Path(source_jsonl))
    grouped: Dict[str, List[Tuple[float, str]]] = {}

    for record in rows:
        prompt, answer = _extract_messages(record)
        if not prompt or not answer:
            continue
        score = _score_record(record, answer)
        grouped.setdefault(prompt, []).append((score, answer))

    pairs: List[Dict[str, Any]] = []
    for prompt, candidates in grouped.items():
        if len(candidates) < 2:
            continue
        sorted_candidates = sorted(candidates, key=lambda item: item[0], reverse=True)
        chosen_score, chosen = sorted_candidates[0]
        rejected_score, rejected = sorted_candidates[-1]
        if chosen_score - rejected_score < 0.25:
            continue
        pairs.append(
            {
                "prompt": prompt,
                "chosen": chosen,
                "rejected": rejected,
                "score_margin": round(chosen_score - rejected_score, 4),
            }
        )

    return _write_jsonl(Path(output_jsonl), pairs)


def build_dataset_manifest(output_path: str, metadata: Dict[str, Any]) -> None:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
