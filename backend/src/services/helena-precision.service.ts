import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { sidecarService } from "./sidecar.service";

type PrecisionAnalysisOptions = {
  userId?: string;
  lookbackDays?: number;
  maxSamples?: number;
};

type TelemetrySummary = {
  lookbackDays: number;
  analyzedSamples: number;
  successCount: number;
  failedCount: number;
  successRate: number;
  avgTokenUsage: number;
  avgExecutionTimeMs: number;
  avgConfidence: number;
  lowConfidenceCount: number;
};

type HelenaPrecisionResult = {
  analysisSummary: string;
  weaknessClusters: string[];
  retrainingPlan: {
    sftExamplesTarget: number;
    dpoPairsTarget: number;
    datasetActions: string[];
  };
  evaluationPlan: string[];
  confidence: number;
  provenance: {
    source: "live" | "mixed" | "fallback";
    retrievedAt: string;
    gaps: string[];
  };
};

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

type HelenaPrecisionBoard = {
  generatedAt: string;
  confidenceTrend: Array<{ date: string; value: number }>;
  failureTrend: Array<{ date: string; value: number }>;
  recommendedTargets: {
    sftExamplesTarget: number;
    dpoPairsTarget: number;
    datasetActions: string[];
  };
  rolloutGate: GateEvaluation;
  provenance: {
    source: "live" | "mixed" | "fallback";
    retrievedAt: string;
    confidence: number;
    gaps: string[];
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAINING_ROOT = path.resolve(process.cwd(), "training");
const NIGHTLY_ROOT = path.join(TRAINING_ROOT, "nightly", "helena");
const ROLLOUT_ROOT = path.join(TRAINING_ROOT, "rollout-gates");
const TARGET_AGENT_NAMES = [
  "opportunity-assessment",
  "idea-validator-stream",
  "client-acquisition-assessment",
  "PROJECT_HEALTH_MONITOR",
  "PROJECT_HEALTH_COMPLETE",
  "DAILY_BRIEFING_GENERATOR",
  "intelligence-chat-stream"
];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const readText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const normalizeConfidence = (value: unknown): number | null => {
  const numeric = readNumber(value);
  if (numeric === null) {
    return null;
  }
  if (numeric <= 1) {
    return clamp(Math.round(numeric * 100), 0, 100);
  }
  return clamp(Math.round(numeric), 0, 100);
};

const extractPrompt = (input: unknown): string => {
  const body = asRecord(input);
  const direct = readText(body?.message);
  if (direct) {
    return direct;
  }
  const query = readText(body?.query);
  if (query) {
    return query;
  }
  return "No explicit prompt captured.";
};

const extractResponse = (output: unknown): string => {
  const body = asRecord(output);
  if (!body) {
    return "No structured output.";
  }

  const direct = readText(body.response);
  if (direct) {
    return direct;
  }

  const recommendation = readText(body.recommendation);
  if (recommendation) {
    return recommendation;
  }

  const strategy = readText(body.strategy);
  if (strategy) {
    return strategy;
  }

  return "Structured output without direct narrative field.";
};

const ensureStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

const safeDay = (date = new Date()): string => date.toISOString().slice(0, 10);

const toTrainingMessages = (prompt: string, response: string): Array<{ role: "system" | "user" | "assistant"; content: string }> => [
  {
    role: "system",
    content: "You are Reex Executive Manager. Provide precise, measurable business guidance with risks and next actions."
  },
  {
    role: "user",
    content: prompt
  },
  {
    role: "assistant",
    content: response
  }
];

const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;

const computeRelevanceScore = (
  recentSamples: Array<{ status: string; prompt: string; response: string }>
): number => {
  const successful = recentSamples.filter((sample) => sample.status === "success");
  if (successful.length === 0) {
    return 45;
  }

  const markerRegex = /(action|next|owner|metric|risk|timeline|kpi)/i;
  const scores = successful.map((sample) => {
    const response = sample.response.trim();
    const hasSignals = markerRegex.test(response) ? 1 : 0;
    const lengthSignal = response.length >= 120 ? 1 : response.length >= 60 ? 0.6 : 0.3;
    const promptWords = new Set(sample.prompt.toLowerCase().split(/\W+/).filter((word) => word.length >= 4));
    const responseWords = new Set(response.toLowerCase().split(/\W+/).filter((word) => word.length >= 4));
    const overlap = Array.from(promptWords).filter((word) => responseWords.has(word)).length;
    const overlapScore = promptWords.size > 0 ? Math.min(1, overlap / Math.max(3, promptWords.size * 0.35)) : 0.4;
    return (hasSignals * 0.4 + lengthSignal * 0.25 + overlapScore * 0.35) * 100;
  });

  return clamp(Math.round(average(scores)), 0, 100);
};

const makeRolloutMetrics = (
  telemetry: TelemetrySummary,
  recentSamples: Array<{ status: string; prompt: string; response: string }>
): RolloutMetrics => {
  const relevanceScore = computeRelevanceScore(recentSamples);
  const failureRate = telemetry.analyzedSamples > 0 ? telemetry.failedCount / telemetry.analyzedSamples : 1;
  const lowConfidenceRate = telemetry.analyzedSamples > 0 ? telemetry.lowConfidenceCount / telemetry.analyzedSamples : 1;
  return {
    timestamp: new Date().toISOString(),
    confidenceScore: clamp(Math.round(telemetry.avgConfidence), 0, 100),
    relevanceScore,
    successRate: Number(telemetry.successRate.toFixed(3)),
    failureRate: Number(failureRate.toFixed(3)),
    lowConfidenceRate: Number(lowConfidenceRate.toFixed(3)),
    sampleCount: telemetry.analyzedSamples
  };
};

const computeRolloutGate = (current: RolloutMetrics, previous: RolloutMetrics | null): GateEvaluation => {
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
    reasons.push("No previous model baseline available; baseline must be established before promotion.");
  }

  return {
    canPromote: reasons.length === 0,
    reasons,
    thresholds,
    current,
    previous
  };
};

const asJsonl = (rows: unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const readLatestRolloutMetrics = async (): Promise<RolloutMetrics | null> => {
  try {
    const historyPath = path.join(ROLLOUT_ROOT, "metrics-history.jsonl");
    const raw = await fs.readFile(historyPath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return null;
    }
    const parsed = JSON.parse(lines[lines.length - 1]) as RolloutMetrics;
    return parsed;
  } catch {
    return null;
  }
};

const persistNightlyArtifacts = async (
  telemetry: TelemetrySummary,
  result: HelenaPrecisionResult,
  recentSamples: Array<{ id: string; agentName: string; status: string; prompt: string; response: string; confidence: number | null; createdAt: string }>,
  failedSamples: Array<{ id: string; agentName: string; errorMessage: string; prompt: string; createdAt: string }>,
  previousMetrics: RolloutMetrics | null
): Promise<{ gate: GateEvaluation; metrics: RolloutMetrics }> => {
  const day = safeDay();
  const dayDir = path.join(NIGHTLY_ROOT, day);
  await fs.mkdir(dayDir, { recursive: true });
  await fs.mkdir(ROLLOUT_ROOT, { recursive: true });

  const sftRows = recentSamples
    .filter((sample) => sample.status === "success" && sample.response.length >= 40)
    .map((sample) => ({
      messages: toTrainingMessages(sample.prompt, sample.response),
      metadata: {
        sourceAgent: sample.agentName,
        sourceLogId: sample.id,
        createdAt: sample.createdAt,
        quality: sample.confidence !== null && sample.confidence >= 65 ? "high" : "medium"
      }
    }));

  const dpoRows = recentSamples
    .filter((sample) => sample.status === "success" && sample.response.length >= 40)
    .slice(0, Math.min(120, failedSamples.length))
    .map((sample, index) => {
      const failed = failedSamples[index];
      return {
        prompt: sample.prompt,
        chosen: sample.response,
        rejected: `Failed output: ${failed.errorMessage}. Prompt context: ${failed.prompt}`,
        metadata: {
          chosenAgent: sample.agentName,
          rejectedAgent: failed.agentName,
          sourceChosenLogId: sample.id,
          sourceRejectedLogId: failed.id,
          generatedAt: new Date().toISOString()
        }
      };
    });

  const sftPath = path.join(dayDir, "manager_sft_incremental.jsonl");
  const dpoPath = path.join(dayDir, "manager_dpo_incremental.jsonl");
  const manifestPath = path.join(dayDir, "manifest.json");

  await fs.writeFile(sftPath, asJsonl(sftRows), "utf8");
  await fs.writeFile(dpoPath, asJsonl(dpoRows), "utf8");

  const metrics = makeRolloutMetrics(telemetry, recentSamples);
  const gate = computeRolloutGate(metrics, previousMetrics);

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: "helena-precision.service",
    telemetry,
    resultSummary: {
      confidence: result.confidence,
      source: result.provenance.source,
      gaps: result.provenance.gaps
    },
    datasetArtifacts: {
      sftPath,
      dpoPath,
      sftRows: sftRows.length,
      dpoRows: dpoRows.length
    },
    rollout: {
      metrics,
      gate
    }
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(path.join(NIGHTLY_ROOT, "latest-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await fs.appendFile(path.join(ROLLOUT_ROOT, "metrics-history.jsonl"), `${JSON.stringify(metrics)}\n`, "utf8");
  await fs.writeFile(path.join(ROLLOUT_ROOT, "current-gate.json"), JSON.stringify(gate, null, 2), "utf8");

  return { gate, metrics };
};

const buildFallbackResult = (gaps: string[]): HelenaPrecisionResult => ({
  analysisSummary: "Telemetry analysis completed with fallback synthesis; strengthen low-confidence paths first.",
  weaknessClusters: [
    "Inconsistent confidence calibration across agents",
    "Sparse labeled preference pairs in failure-heavy workflows",
    "Insufficient follow-up outcome linkage for closed-loop learning"
  ],
  retrainingPlan: {
    sftExamplesTarget: 1200,
    dpoPairsTarget: 240,
    datasetActions: [
      "Prioritize failed and low-confidence logs for manual correction labels.",
      "Export weekly preference pairs grouped by agent workflow.",
      "Join outcome tables to agent decisions before the next training run."
    ]
  },
  evaluationPlan: [
    "Track response relevance and faithfulness on 100 held-out prompts.",
    "Gate model promotion on confidence calibration and business KPI lift.",
    "Compare new model against current model on deterministic replay set."
  ],
  confidence: 58,
  provenance: {
    source: "fallback",
    retrievedAt: new Date().toISOString(),
    gaps
  }
});

export async function runHelenaPrecisionAnalysis(options: PrecisionAnalysisOptions = {}): Promise<{
  telemetry: TelemetrySummary;
  result: HelenaPrecisionResult;
}> {
  const lookbackDays = clamp(options.lookbackDays ?? 14, 3, 60);
  const maxSamples = clamp(options.maxSamples ?? 500, 100, 2000);
  const since = new Date(Date.now() - lookbackDays * DAY_MS);

  const logs = await prisma.agentLog.findMany({
    where: {
      createdAt: { gte: since },
      agentName: { in: TARGET_AGENT_NAMES },
      ...(options.userId ? { userId: options.userId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: maxSamples,
    select: {
      id: true,
      agentName: true,
      status: true,
      input: true,
      output: true,
      tokenUsage: true,
      executionTimeMs: true,
      errorMessage: true,
      createdAt: true
    }
  });

  const successCount = logs.filter((item) => item.status === "success").length;
  const failedCount = logs.length - successCount;
  const tokenUsageValues = logs.map((item) => item.tokenUsage).filter((value): value is number => typeof value === "number");
  const executionValues = logs
    .map((item) => item.executionTimeMs)
    .filter((value): value is number => typeof value === "number");
  const confidenceValues = logs
    .map((item) => normalizeConfidence(asRecord(item.output)?.confidence))
    .filter((value): value is number => typeof value === "number");

  const avg = (values: number[]): number =>
    values.length > 0 ? Math.round(values.reduce((sum, item) => sum + item, 0) / values.length) : 0;

  const lowConfidenceSamples = logs
    .map((item) => {
      const output = asRecord(item.output);
      const confidence = normalizeConfidence(output?.confidence);
      return {
        id: item.id,
        agentName: item.agentName,
        confidence,
        prompt: extractPrompt(item.input),
        response: extractResponse(item.output),
        createdAt: item.createdAt.toISOString()
      };
    })
    .filter((item) => item.confidence !== null && item.confidence < 60)
    .slice(0, 40);

  const failedSamples = logs
    .filter((item) => item.status === "failed")
    .slice(0, 30)
    .map((item) => ({
      id: item.id,
      agentName: item.agentName,
      errorMessage: item.errorMessage ?? "Unknown failure",
      prompt: extractPrompt(item.input),
      createdAt: item.createdAt.toISOString()
    }));

  const recentSamples = logs.slice(0, 120).map((item) => {
    const output = asRecord(item.output);
    return {
      id: item.id,
      agentName: item.agentName,
      status: item.status,
      confidence: normalizeConfidence(output?.confidence),
      prompt: extractPrompt(item.input),
      response: extractResponse(item.output),
      tokenUsage: item.tokenUsage,
      executionTimeMs: item.executionTimeMs,
      createdAt: item.createdAt.toISOString()
    };
  });

  const telemetry: TelemetrySummary = {
    lookbackDays,
    analyzedSamples: logs.length,
    successCount,
    failedCount,
    successRate: logs.length > 0 ? Number((successCount / logs.length).toFixed(3)) : 0,
    avgTokenUsage: avg(tokenUsageValues),
    avgExecutionTimeMs: avg(executionValues),
    avgConfidence: avg(confidenceValues),
    lowConfidenceCount: lowConfidenceSamples.length
  };

  const gaps: string[] = [];
  if (logs.length < 120) {
    gaps.push("Low telemetry volume for current lookback window.");
  }
  if (failedSamples.length === 0) {
    gaps.push("No recent failed samples available for contrastive tuning.");
  }
  if (lowConfidenceSamples.length === 0) {
    gaps.push("No low-confidence samples detected; calibration signal may be sparse.");
  }

  const sidecarPayload = {
    telemetry,
    lowConfidenceSamples,
    failedSamples,
    recentSamples,
    constraints: [
      "Prioritize precision improvement over creativity.",
      "Recommend only actions feasible with local training stack.",
      "Return measurable targets for SFT and DPO data collection."
    ]
  };

  let result: HelenaPrecisionResult;
  try {
    const sidecar = await sidecarService.invokeAgent<Record<string, unknown>>("/helena/precision/analyze", sidecarPayload);
    const output = asRecord(sidecar.output);
    if (!output) {
      throw new Error("Invalid sidecar precision output.");
    }

    result = {
      analysisSummary:
        readText(output.analysisSummary) ??
        "Telemetry analysis produced a structured response without summary text.",
      weaknessClusters: ensureStringArray(output.weaknessClusters).slice(0, 8),
      retrainingPlan: {
        sftExamplesTarget: clamp(readNumber(asRecord(output.retrainingPlan)?.sftExamplesTarget) ?? 1200, 300, 12000),
        dpoPairsTarget: clamp(readNumber(asRecord(output.retrainingPlan)?.dpoPairsTarget) ?? 240, 50, 5000),
        datasetActions: ensureStringArray(asRecord(output.retrainingPlan)?.datasetActions).slice(0, 8)
      },
      evaluationPlan: ensureStringArray(output.evaluationPlan).slice(0, 8),
      confidence: clamp(readNumber(output.confidence) ?? 65, 35, 95),
      provenance: {
        source: (readText(asRecord(output.provenance)?.source) as "live" | "mixed" | "fallback") ?? "mixed",
        retrievedAt: readText(asRecord(output.provenance)?.retrievedAt) ?? new Date().toISOString(),
        gaps: ensureStringArray(asRecord(output.provenance)?.gaps)
      }
    };
  } catch (error) {
    logger.warn({ error }, "[HELENA_PRECISION] Sidecar precision analysis failed; using fallback synthesis.");
    result = buildFallbackResult(gaps);
  }

  const previousMetrics = await readLatestRolloutMetrics();
  const artifactOutput = await persistNightlyArtifacts(telemetry, result, recentSamples, failedSamples, previousMetrics).catch((error) => {
    logger.warn({ error }, "[HELENA_PRECISION] Failed to persist nightly artifacts.");
    return null;
  });

  await prisma.agentLog.create({
    data: {
      agentName: "HELENA_PRECISION_ANALYZER",
      userId: options.userId,
      status: "success",
      input: {
        telemetry,
        lookbackDays,
        maxSamples,
        targetAgents: TARGET_AGENT_NAMES
      },
      output: {
        result,
        source: "helena-precision.service",
        retrievedAt: new Date().toISOString(),
        confidence: result.confidence,
        gaps: result.provenance.gaps,
        rolloutGate: artifactOutput?.gate ?? null,
        rolloutMetrics: artifactOutput?.metrics ?? null
      }
    }
  });

  return { telemetry, result };
}

export async function getHelenaPrecisionBoard(userId?: string): Promise<HelenaPrecisionBoard> {
  const since = new Date(Date.now() - 14 * DAY_MS);

  const [precisionLogs, failureLogs] = await Promise.all([
    prisma.agentLog.findMany({
      where: {
        agentName: "HELENA_PRECISION_ANALYZER",
        createdAt: { gte: since },
        ...(userId ? { userId } : {})
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, output: true }
    }),
    prisma.agentLog.findMany({
      where: {
        agentName: { in: TARGET_AGENT_NAMES },
        createdAt: { gte: since },
        status: "failed",
        ...(userId ? { userId } : {})
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true }
    })
  ]);

  const confidenceTrend = precisionLogs.map((item) => {
    const output = asRecord(item.output);
    const result = asRecord(output?.result);
    return {
      date: item.createdAt.toISOString().slice(0, 10),
      value: clamp(readNumber(result?.confidence) ?? 55, 0, 100)
    };
  });

  const failedByDay = new Map<string, number>();
  for (const item of failureLogs) {
    const day = item.createdAt.toISOString().slice(0, 10);
    failedByDay.set(day, (failedByDay.get(day) ?? 0) + 1);
  }
  const failureTrend = Array.from(failedByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));

  const latest = precisionLogs.length > 0 ? asRecord(precisionLogs[precisionLogs.length - 1].output) : null;
  const latestResult = asRecord(latest?.result);
  const retrainingPlan = asRecord(latestResult?.retrainingPlan);

  let gate: GateEvaluation;
  try {
    const raw = await fs.readFile(path.join(ROLLOUT_ROOT, "current-gate.json"), "utf8");
    gate = JSON.parse(raw) as GateEvaluation;
  } catch {
    const current = {
      timestamp: new Date().toISOString(),
      confidenceScore: clamp(readNumber(latestResult?.confidence) ?? 55, 0, 100),
      relevanceScore: 50,
      successRate: 0,
      failureRate: 1,
      lowConfidenceRate: 1,
      sampleCount: 0
    };
    gate = computeRolloutGate(current, null);
  }

  return {
    generatedAt: new Date().toISOString(),
    confidenceTrend: confidenceTrend.slice(-14),
    failureTrend: failureTrend.slice(-14),
    recommendedTargets: {
      sftExamplesTarget: clamp(readNumber(retrainingPlan?.sftExamplesTarget) ?? 1200, 300, 12000),
      dpoPairsTarget: clamp(readNumber(retrainingPlan?.dpoPairsTarget) ?? 240, 50, 5000),
      datasetActions: ensureStringArray(retrainingPlan?.datasetActions).slice(0, 6)
    },
    rolloutGate: gate,
    provenance: {
      source: latestResult ? "mixed" : "fallback",
      retrievedAt: new Date().toISOString(),
      confidence: latestResult ? clamp(readNumber(latestResult.confidence) ?? 60, 40, 95) : 45,
      gaps: latestResult ? ensureStringArray(asRecord(latestResult.provenance)?.gaps) : ["No precision logs available yet."]
    }
  };
}