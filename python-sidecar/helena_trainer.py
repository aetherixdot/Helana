from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

from helena_dataset import build_dataset_manifest, build_dpo_pairs, split_sft_dataset


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


def _messages_to_text(messages: Sequence[Dict[str, str]]) -> str:
    parts: List[str] = []
    for item in messages:
        role = item.get("role", "user")
        content = item.get("content", "").strip()
        if not content:
            continue
        parts.append(f"<|{role}|>\n{content}")
    return "\n\n".join(parts)


def _load_sft_text_rows(path: Path) -> List[Dict[str, str]]:
    rows = _read_jsonl(path)
    out: List[Dict[str, str]] = []
    for row in rows:
        messages = row.get("messages")
        if not isinstance(messages, list):
            continue
        valid_messages = [
            {"role": str(item.get("role", "user")), "content": str(item.get("content", ""))}
            for item in messages
            if isinstance(item, dict) and isinstance(item.get("content"), str)
        ]
        text = _messages_to_text(valid_messages)
        if text:
            out.append({"text": text})
    return out


def run_sft_lora(
    base_model: str,
    train_file: str,
    val_file: str,
    output_dir: str,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    max_length: int,
) -> Dict[str, Any]:
    try:
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            Trainer,
            TrainingArguments,
            default_data_collator,
        )
    except ImportError as exc:
        raise RuntimeError(
            "Missing training dependencies. Install with: pip install -r requirements-training.txt"
        ) from exc

    train_rows = _load_sft_text_rows(Path(train_file))
    val_rows = _load_sft_text_rows(Path(val_file))
    if len(train_rows) < 20:
        raise ValueError("Need at least 20 training examples for SFT.")

    tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(base_model, device_map="auto")
    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)

    train_dataset = Dataset.from_list(train_rows)
    val_dataset = Dataset.from_list(val_rows) if val_rows else None

    def tokenize_batch(batch: Dict[str, List[str]]) -> Dict[str, Any]:
        tokens = tokenizer(
            batch["text"],
            truncation=True,
            max_length=max_length,
            padding="max_length",
        )
        tokens["labels"] = [list(item) for item in tokens["input_ids"]]
        return tokens

    tokenized_train = train_dataset.map(tokenize_batch, batched=True, remove_columns=["text"])
    tokenized_val = val_dataset.map(tokenize_batch, batched=True, remove_columns=["text"]) if val_dataset else None

    train_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=learning_rate,
        evaluation_strategy="epoch" if tokenized_val is not None else "no",
        logging_strategy="steps",
        logging_steps=10,
        save_strategy="epoch",
        report_to=[],
        fp16=False,
        bf16=False,
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=train_args,
        train_dataset=tokenized_train,
        eval_dataset=tokenized_val,
        data_collator=default_data_collator,
        tokenizer=tokenizer,
    )
    trainer.train()

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    result = {
        "base_model": base_model,
        "output_dir": output_dir,
        "train_rows": len(train_rows),
        "val_rows": len(val_rows),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "max_length": max_length,
    }
    Path(output_dir, "sft_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def _load_dpo_rows(path: Path) -> List[Dict[str, str]]:
    rows = _read_jsonl(path)
    out: List[Dict[str, str]] = []
    for row in rows:
        prompt = row.get("prompt")
        chosen = row.get("chosen")
        rejected = row.get("rejected")
        if not all(isinstance(value, str) and value.strip() for value in [prompt, chosen, rejected]):
            continue
        out.append({"prompt": prompt.strip(), "chosen": chosen.strip(), "rejected": rejected.strip()})
    return out


def run_dpo(
    base_or_sft_model: str,
    train_file: str,
    val_file: str,
    output_dir: str,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    beta: float,
    max_length: int,
    max_prompt_length: int,
) -> Dict[str, Any]:
    try:
        from datasets import Dataset
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from trl import DPOConfig, DPOTrainer
    except ImportError as exc:
        raise RuntimeError(
            "Missing DPO dependencies. Install with: pip install -r requirements-training.txt"
        ) from exc

    train_rows = _load_dpo_rows(Path(train_file))
    val_rows = _load_dpo_rows(Path(val_file)) if Path(val_file).exists() else []
    if len(train_rows) < 12:
        raise ValueError("Need at least 12 preference pairs for DPO.")

    tokenizer = AutoTokenizer.from_pretrained(base_or_sft_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(base_or_sft_model, device_map="auto")

    train_dataset = Dataset.from_list(train_rows)
    val_dataset = Dataset.from_list(val_rows) if val_rows else None

    dpo_args = DPOConfig(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=learning_rate,
        beta=beta,
        logging_steps=10,
        evaluation_strategy="epoch" if val_dataset is not None else "no",
        save_strategy="epoch",
        report_to=[],
    )

    trainer = DPOTrainer(
        model=model,
        ref_model=None,
        args=dpo_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        tokenizer=tokenizer,
        max_length=max_length,
        max_prompt_length=max_prompt_length,
    )
    trainer.train()

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)
    result = {
        "base_model": base_or_sft_model,
        "output_dir": output_dir,
        "train_pairs": len(train_rows),
        "val_pairs": len(val_rows),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "beta": beta,
    }
    Path(output_dir, "dpo_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def evaluate_format_adherence(test_file: str) -> Dict[str, Any]:
    rows = _read_jsonl(Path(test_file))
    if not rows:
        return {"rows": 0, "adherence_rate": 0.0}

    valid = 0
    for row in rows:
        messages = row.get("messages")
        if not isinstance(messages, list):
            continue
        assistant_messages = [
            item.get("content", "")
            for item in messages
            if isinstance(item, dict) and item.get("role") == "assistant" and isinstance(item.get("content"), str)
        ]
        if not assistant_messages:
            continue
        text = assistant_messages[-1].lower()
        has_action = any(marker in text for marker in ["action", "next", "owner", "follow-up"])
        has_metric = any(marker in text for marker in ["kpi", "metric", "%", "days", "week"])
        if has_action and has_metric:
            valid += 1

    adherence = valid / max(len(rows), 1)
    return {"rows": len(rows), "adherence_rate": round(adherence, 4), "valid_rows": valid}


def command_prepare(args: argparse.Namespace) -> None:
    summary = split_sft_dataset(
        source_jsonl=args.source,
        output_dir=args.output_dir,
        seed=args.seed,
        val_ratio=args.val_ratio,
        test_ratio=args.test_ratio,
    )
    dpo_count = build_dpo_pairs(
        source_jsonl=args.source,
        output_jsonl=str(Path(args.output_dir) / "train.dpo.jsonl"),
    )

    manifest = {
        "source": args.source,
        "output_dir": args.output_dir,
        "train_count": summary.train_count,
        "val_count": summary.val_count,
        "test_count": summary.test_count,
        "dpo_pairs": dpo_count,
    }
    build_dataset_manifest(str(Path(args.output_dir) / "manifest.json"), manifest)
    print(json.dumps(manifest, indent=2))


def command_train_sft(args: argparse.Namespace) -> None:
    result = run_sft_lora(
        base_model=args.base_model,
        train_file=args.train_file,
        val_file=args.val_file,
        output_dir=args.output_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        max_length=args.max_length,
    )
    print(json.dumps(result, indent=2))


def command_train_dpo(args: argparse.Namespace) -> None:
    result = run_dpo(
        base_or_sft_model=args.model,
        train_file=args.train_file,
        val_file=args.val_file,
        output_dir=args.output_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        beta=args.beta,
        max_length=args.max_length,
        max_prompt_length=args.max_prompt_length,
    )
    print(json.dumps(result, indent=2))


def command_evaluate(args: argparse.Namespace) -> None:
    result = evaluate_format_adherence(args.test_file)
    print(json.dumps(result, indent=2))


def command_train_forecast(args: argparse.Namespace) -> None:
    from helena_forecaster import train_forecaster_from_csv

    result = train_forecaster_from_csv(
        csv_path=args.csv,
        target_column=args.target,
        model_output_path=args.model_output,
        metrics_output_path=args.metrics_output,
    )
    print(json.dumps(result, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Helena training orchestration for Reex.")
    sub = parser.add_subparsers(dest="command", required=True)

    prepare = sub.add_parser("prepare", help="Split SFT data and generate DPO pairs.")
    prepare.add_argument("--source", default="training/manager_sft.jsonl")
    prepare.add_argument("--output-dir", default="training/processed")
    prepare.add_argument("--seed", type=int, default=42)
    prepare.add_argument("--val-ratio", type=float, default=0.1)
    prepare.add_argument("--test-ratio", type=float, default=0.1)
    prepare.set_defaults(func=command_prepare)

    sft = sub.add_parser("train-sft", help="Run LoRA SFT training.")
    sft.add_argument("--base-model", default="Qwen/Qwen3-8B")
    sft.add_argument("--train-file", default="training/processed/train.sft.jsonl")
    sft.add_argument("--val-file", default="training/processed/val.sft.jsonl")
    sft.add_argument("--output-dir", default="models/helena-sft")
    sft.add_argument("--epochs", type=int, default=2)
    sft.add_argument("--batch-size", type=int, default=1)
    sft.add_argument("--learning-rate", type=float, default=2e-4)
    sft.add_argument("--max-length", type=int, default=1024)
    sft.set_defaults(func=command_train_sft)

    dpo = sub.add_parser("train-dpo", help="Run DPO preference training.")
    dpo.add_argument("--model", default="models/helena-sft")
    dpo.add_argument("--train-file", default="training/processed/train.dpo.jsonl")
    dpo.add_argument("--val-file", default="training/processed/val.dpo.jsonl")
    dpo.add_argument("--output-dir", default="models/helena-dpo")
    dpo.add_argument("--epochs", type=int, default=1)
    dpo.add_argument("--batch-size", type=int, default=1)
    dpo.add_argument("--learning-rate", type=float, default=5e-6)
    dpo.add_argument("--beta", type=float, default=0.1)
    dpo.add_argument("--max-length", type=int, default=1024)
    dpo.add_argument("--max-prompt-length", type=int, default=512)
    dpo.set_defaults(func=command_train_dpo)

    eval_cmd = sub.add_parser("evaluate", help="Evaluate format adherence on holdout file.")
    eval_cmd.add_argument("--test-file", default="training/processed/test.sft.jsonl")
    eval_cmd.set_defaults(func=command_evaluate)

    forecast = sub.add_parser("train-forecast", help="Train classical forecaster from CSV.")
    forecast.add_argument("--csv", default="training/forecast_features.csv")
    forecast.add_argument("--target", default="target_next_week_wins")
    forecast.add_argument("--model-output", default="models/helena_forecaster.joblib")
    forecast.add_argument("--metrics-output", default="models/helena_forecaster_metrics.json")
    forecast.set_defaults(func=command_train_forecast)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
