from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score


def train_forecaster_from_csv(
    csv_path: str,
    target_column: str,
    model_output_path: str,
    metrics_output_path: str,
) -> Dict[str, Any]:
    df = pd.read_csv(csv_path)
    if target_column not in df.columns:
        raise ValueError(f"Missing target column '{target_column}'.")

    df = df.dropna(subset=[target_column]).copy()
    if len(df) < 24:
        raise ValueError("Need at least 24 rows for forecasting training.")

    feature_columns = [col for col in df.columns if col != target_column]
    X = df[feature_columns].fillna(0.0)
    y = df[target_column].astype(float)

    split = int(len(df) * 0.8)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]

    model = RandomForestRegressor(
        n_estimators=400,
        max_depth=8,
        random_state=42,
        min_samples_leaf=2,
    )
    model.fit(X_train, y_train)
    preds = model.predict(X_test)

    rmse = mean_squared_error(y_test, preds) ** 0.5
    metrics = {
        "rows": int(len(df)),
        "train_rows": int(len(X_train)),
        "test_rows": int(len(X_test)),
        "mae": float(mean_absolute_error(y_test, preds)),
        "rmse": float(rmse),
        "r2": float(r2_score(y_test, preds)),
        "feature_columns": feature_columns,
        "target_column": target_column,
    }

    model_artifact = {"model": model, "feature_columns": feature_columns, "target_column": target_column}
    Path(model_output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(metrics_output_path).parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model_artifact, model_output_path)
    Path(metrics_output_path).write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return metrics


def predict_with_saved_model(model_path: str, row: Dict[str, float]) -> Dict[str, Any]:
    artifact = joblib.load(model_path)
    model = artifact["model"]
    feature_columns = artifact["feature_columns"]
    target_column = artifact["target_column"]

    payload = {feature: float(row.get(feature, 0.0)) for feature in feature_columns}
    frame = pd.DataFrame([payload], columns=feature_columns)
    prediction = float(model.predict(frame)[0])
    return {
        "target_column": target_column,
        "prediction": prediction,
        "features_used": payload,
    }
