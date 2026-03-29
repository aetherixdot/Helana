import fs from "node:fs/promises";
import path from "node:path";

type RolloutMetrics = {
  timestamp: string;
  confidenceScore: number;
  relevanceScore: number;
  successRate: number;
  failureRate: number;
  lowConfidenceRate: number;
  sampleCount: number;
};

type GateEvaluation = {
  canPromote: boolean;
  reasons: string[];
  thresholds: {
    minConfidenceDelta: number;
    minRelevanceDelta: number;
    minSuccessRate: number;
  };
  current: RolloutMetrics;
  previous: RolloutMetrics | null;
};

const TRAINING_ROOT = path.resolve(process.cwd(), "training");
const ROLLOUT_ROOT = path.join(TRAINING_ROOT, "rollout-gates");

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const computeGate = (current: RolloutMetrics, previous: RolloutMetrics | null): GateEvaluation => {
  const thresholds = {
    minConfidenceDelta: 2,
    minRelevanceDelta: 2,
    minSuccessRate: 0.62
  };

  const reasons: string[] = [];

  if (current.successRate < thresholds.minSuccessRate) {
    reasons.push(`Success rate ${current.successRate} below ${thresholds.minSuccessRate}.`);
  }

  if (previous) {
    const confidenceDelta = current.confidenceScore - previous.confidenceScore;
    const relevanceDelta = current.relevanceScore - previous.relevanceScore;
    if (confidenceDelta < thresholds.minConfidenceDelta) {
      reasons.push(`Confidence delta ${confidenceDelta} below required ${thresholds.minConfidenceDelta}.`);
    }
    if (relevanceDelta < thresholds.minRelevanceDelta) {
      reasons.push(`Relevance delta ${relevanceDelta} below required ${thresholds.minRelevanceDelta}.`);
    }
  } else {
    reasons.push("No previous baseline available. Run at least two nightly cycles before promotion.");
  }

  return {
    canPromote: reasons.length === 0,
    reasons,
    thresholds,
    current,
    previous
  };
};

async function loadMetricsHistory(): Promise<RolloutMetrics[]> {
  const historyPath = path.join(ROLLOUT_ROOT, "metrics-history.jsonl");
  const raw = await fs.readFile(historyPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RolloutMetrics)
    .map((row) => ({
      ...row,
      confidenceScore: clamp(Math.round(row.confidenceScore), 0, 100),
      relevanceScore: clamp(Math.round(row.relevanceScore), 0, 100)
    }));
}

async function run(): Promise<void> {
  const history = await loadMetricsHistory();
  if (history.length === 0) {
    throw new Error("No rollout metrics found. Run Helena precision analysis first.");
  }

  const current = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const gate = computeGate(current, previous);

  await fs.mkdir(ROLLOUT_ROOT, { recursive: true });
  await fs.writeFile(path.join(ROLLOUT_ROOT, "current-gate.json"), JSON.stringify(gate, null, 2), "utf8");

  console.log("Helena rollout gate evaluation:");
  console.log(JSON.stringify(gate, null, 2));

  if (!gate.canPromote) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("Helena rollout gate evaluation failed.");
  console.error(error);
  process.exit(1);
});
