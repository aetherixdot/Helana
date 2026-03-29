import { Request, Response } from "express";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { NotFoundError, UnauthorizedError, ValidationError } from "../utils/app-error";
import { sendSuccess } from "../utils/response";
import { catchAsync } from "../utils/async-handler";
import {
  buildIntelligenceExportFile,
  buildIntelligenceExportPreview,
  IntelligenceExportFormat
} from "../services/intelligence-export.service";
import { generateExecutiveManagerResponse } from "../services/executive-manager.service";
import { getHelenaPrecisionBoard, runHelenaPrecisionAnalysis } from "../services/helena-precision.service";
import { createProject, findProjectByDomainForUser } from "../services/project.service";
import { orchestrateAnalysis } from "../services/analysis.service";
import { estimateImpact } from "../intelligence/impactEstimator.service";
import type {
  CompetitorGapResult,
  DerivedFeatures,
  DetectedIssue,
  ExecutionBlueprint,
  MarketPositionResult,
  NormalizedSignals,
  PrioritizedImprovementRoadmap,
  PriorityAction
} from "../intelligence/types";

// --- Types ---

type IntelligenceDecisionViewPayload = {
  metadata: {
    targetUrl: string;
    projectName: string;
    snapshotId: string;
    healthTrend: number | null;
  };
  normalizedSignals: NormalizedSignals;
  derivedFeatures: DerivedFeatures;
  detectedIssues: DetectedIssue[];
  impactAssessments: ReturnType<typeof estimateImpact>[];
  priorityActions: PriorityAction[];
  roadmap: PrioritizedImprovementRoadmap;
  executionBlueprints: ExecutionBlueprint[];
  competitorGap: CompetitorGapResult | null;
  marketPosition: MarketPositionResult;
};

type OpportunityAssessmentInput = {
  idea: string;
  targetMarket: string;
  serviceFocus: string;
  launchWindowMonths?: number;
  constraints?: string[];
};

type OpportunityAssessmentResult = {
  scorecard: {
    marketNeedScore: number;
    clientFitScore: number;
    differentiationScore: number;
    deliveryReadinessScore: number;
    riskScore: number;
    overallScore: number;
  };
  decision: "GO" | "PILOT" | "HOLD";
  rationale: string[];
  marketSizing: {
    tamMillions: number;
    samMillions: number;
    somMillions: number;
    benchmarkVerdict: "UNDERSIZED" | "EMERGING" | "SCALABLE";
    competitorPressure: "LOW" | "MEDIUM" | "HIGH";
  };
  provenance: {
    method: "deterministic-rules-v1";
    generatedAt: string;
    confidence: number;
  };
};

type ClientCandidateInput = {
  accountName: string;
  industry: string;
  website?: string;
  geography?: string;
  estimatedAnnualBudget?: number;
  urgencyLevel?: "low" | "medium" | "high";
  decisionWindowDays?: number;
  painPoints: string[];
  currentTools?: string[];
};

type ClientAcquisitionInput = {
  serviceProfile: string;
  targetIndustries: string[];
  geoFocus?: string[];
  revenueGoalQuarter?: number;
  constraints?: string[];
  accounts: ClientCandidateInput[];
};

type ClientAcquisitionAssessment = {
  summary: {
    totalAccounts: number;
    takeNowCount: number;
    nurtureCount: number;
    averageWinProbability: number;
  };
  prioritizedAccounts: Array<{
    accountName: string;
    recommendation: "TAKE_NOW" | "NURTURE" | "PASS";
    scores: {
      icpFitScore: number;
      budgetFitScore: number;
      urgencyScore: number;
      painSeverityScore: number;
      winProbability: number;
    };
    pitchAngles: string[];
    conversationScript: string[];
    followUpPlan: {
      primaryContactWindow: string;
      secondFollowUp: string;
      escalationCheck: string;
    };
    evidence: {
      matchedIndustry: boolean;
      matchedGeoFocus: boolean;
      topPainSignals: string[];
    };
  }>;
  provenance: {
    method: "deterministic-client-fit-v1";
    generatedAt: string;
    confidence: number;
  };
};

type DemandForecastInput = {
  horizonWeeks?: number;
  targetMarket?: string;
  serviceFocus?: string;
};

type DemandForecastResult = {
  horizonWeeks: number;
  generatedAt: string;
  kpis: {
    recentOpportunityAssessments: number;
    recentClientAssessments: number;
    adaptiveWinRate: number;
    activeProjects: number;
    averageProjectScore: number;
  };
  demandIndex: number;
  outlook: "EXPAND" | "HOLD" | "DEFEND";
  forecastBands: {
    conservativeQualifiedPipeline: number;
    baseQualifiedPipeline: number;
    aggressiveQualifiedPipeline: number;
  };
  recommendedActions: string[];
  provenance: IntelligenceProvenance;
};

type DailyBriefingResult = {
  generatedAt: string;
  overview: {
    momentum: "STRONG" | "STEADY" | "AT_RISK";
    headline: string;
  };
  signals: {
    ceo: {
      signal: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      nextAction: string;
    };
    product: {
      signal: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      nextAction: string;
    };
    sales: {
      signal: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      nextAction: string;
    };
    marketing: {
      signal: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      nextAction: string;
    };
    delivery: {
      signal: string;
      riskLevel: "LOW" | "MEDIUM" | "HIGH";
      nextAction: string;
    };
  };
  topRisks: string[];
  topOpportunities: string[];
  provenance: IntelligenceProvenance;
};

type IntelligenceInsightFeedItem = {
  id: string;
  title: string;
  summary: string;
  category: "risk" | "opportunity" | "recommendation";
  priority: "LOW" | "MEDIUM" | "HIGH";
  generatedAt: string;
  sourceAgent: string;
  isRead: boolean;
};

type IntelligenceChatStreamInput = {
  message: string;
  context?: Record<string, unknown>;
};

type IntelligenceChatActionCard = {
  id: string;
  kind: "open_route" | "create_reminder";
  label: string;
  description: string;
  route?: string;
  reminder?: {
    title: string;
    dueInHours: number;
    type: "AI_ACTION" | "CLIENT_FOLLOW_UP";
  };
};

type MarketingGuidanceInput = {
  campaignHorizonWeeks?: number;
  focusGoal?: "PIPELINE" | "CONVERSION" | "RETENTION";
  marketContext?: string;
};

type MarketingGuidanceResult = {
  campaignHorizonWeeks: number;
  generatedAt: string;
  focusGoal: "PIPELINE" | "CONVERSION" | "RETENTION";
  channelPriorities: Array<{
    channel: "Email" | "LinkedIn" | "Webinar" | "CaseStudy";
    priority: "HIGH" | "MEDIUM" | "LOW";
    rationale: string;
  }>;
  contentRecommendations: Array<{
    title: string;
    format: "post" | "email-sequence" | "webinar" | "case-study";
    objective: string;
  }>;
  outreachGuidance: {
    cadencePerWeek: number;
    targetAccountMix: {
      takeNowPercent: number;
      nurturePercent: number;
    };
  };
  provenance: IntelligenceProvenance;
};

type ProjectMonitoringInput = {
  maxProjects?: number;
  minScoreThreshold?: number;
};

type ProductRoadmapInput = {
  planningHorizonWeeks?: number;
  maxInitiatives?: number;
  strategicTheme?: string;
};

type RoadmapOutcomeCaptureInput = {
  projectId: string;
  recommendationTitle: string;
  implementationStatus: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" | "STALLED" | "DELAYED" | "DEFERRED" | "CANCELLED";
  predictedImprovement?: number;
  observedImprovement?: number;
  learningScore?: number;
  note?: string;
};

type ProductRoadmapResult = {
  generatedAt: string;
  planningHorizonWeeks: number;
  strategicTheme: string | null;
  signalSummary: {
    analyzedProjects: number;
    atRiskProjects: number;
    averageProjectScore: number;
    adaptiveWinRate: number;
    implementationOutcomeCount: number;
  };
  initiatives: Array<{
    title: string;
    issueType: string;
    recommendation: string;
    priorityBand: "NOW" | "NEXT" | "LATER";
    expectedImpactScore: number;
    confidence: number;
    timelineWeeks: number;
    owner: "product" | "engineering" | "growth";
    rationale: string[];
    evidence: {
      sourceProjectIds: string[];
      sourceActionCount: number;
      averagePriorityScore: number;
    };
  }>;
  learningAdjustments: string[];
  provenance: IntelligenceProvenance;
};

type ProjectMonitoringResult = {
  generatedAt: string;
  projectCount: number;
  minScoreThreshold: number;
  alerts: {
    critical: number;
    warning: number;
    healthy: number;
  };
  projects: Array<{
    projectId: string;
    projectName: string;
    latestScore: number | null;
    trendPulse: number | null;
    alertLevel: "CRITICAL" | "WARNING" | "HEALTHY";
    riskSignals: string[];
    topFeatureUpdates: Array<{
      recommendation: string;
      issueType: string;
      priorityScore: number;
      confidence: number;
    }>;
    provenance: IntelligenceProvenance;
  }>;
  aggregatedRecommendations: string[];
  provenance: IntelligenceProvenance;
};

type IntelligenceProvenance = {
  method: string;
  source: "live" | "mixed" | "fallback";
  retrievedAt: string;
  confidence: number;
  gaps: string[];
};

type IntelligenceReportGraph = Prisma.IntelligenceReportGetPayload<{
  include: {
    featureVector: true;
    derivedFeature: true;
    detectedIssues: true;
    competitorSignals: true;
    marketPosition: true;
    priorityActions: true;
    implementationOutcomes: true;
    snapshot: {
      select: {
        id: true;
        url: true;
        projectId: true;
        project: {
          select: {
            userId: true;
            name: true;
          };
        };
      };
    };
  };
}>;

type IntelligenceRecord = {
  snapshotId: string;
  url: string;
  report: IntelligenceReportGraph;
};

// --- Helpers ---

const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, value));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const requireUser = (req: Request): { id: string; role: UserRole } => {
  const user = (req as any).user;
  if (!user) {
    throw new UnauthorizedError();
  }
  return { id: user.id, role: user.role };
};

const canReadProject = (role: UserRole, ownerId: string, requesterId: string): boolean => {
  if (role === "admin" || role === "analyst") {
    return true;
  }
  return ownerId === requesterId;
};

const getIntelligenceRecord = async (
  snapshotId: string,
  userId: string,
  role: UserRole
): Promise<IntelligenceRecord> => {
  const report = await prisma.intelligenceReport.findUnique({
    where: { snapshotId },
    include: {
      featureVector: true,
      derivedFeature: true,
      detectedIssues: {
        orderBy: { severity: "desc" }
      },
      competitorSignals: {
        orderBy: [{ positionScore: "desc" }, { createdAt: "desc" }]
      },
      marketPosition: true,
      priorityActions: {
        orderBy: { priorityScore: "desc" }
      },
      implementationOutcomes: {
        orderBy: { createdAt: "desc" }
      },
      snapshot: {
        select: {
          id: true,
          url: true,
          projectId: true,
          project: {
            select: {
              userId: true,
              name: true
            }
          }
        }
      }
    }
  });

  if (!report || !report.snapshot) {
    throw new NotFoundError("Intelligence report not found.");
  }
  if (!canReadProject(role, report.snapshot.project.userId, userId)) {
    throw new UnauthorizedError("You are not allowed to access this intelligence report.");
  }

  const { snapshot } = report;

  return {
    snapshotId,
    url: snapshot.url,
    report
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const pickNumber = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const asDetectedIssue = (row: {
  issueType: string;
  severity: number;
  category: string | null;
  confidence: number | null;
  evidence: Prisma.JsonValue | null;
}): DetectedIssue => ({
  type: row.issueType,
  severity: row.severity,
  category: (row.category as DetectedIssue["category"]) ?? undefined,
  confidence: row.confidence ?? undefined,
  evidence: readJsonRecord(row.evidence)
});

const asPriorityAction = (row: {
  issueType: string;
  recommendation: string;
  severity: number;
  impactScore: number;
  priorityScore: number;
  confidence: number | null;
  category: string | null;
  rawData: Prisma.JsonValue | null;
}): PriorityAction => {
  const raw = readJsonRecord(row.rawData);
  return {
    issueType: row.issueType,
    recommendation: row.recommendation,
    severity: row.severity,
    impactScore: row.impactScore,
    priorityScore: row.priorityScore,
    confidence: row.confidence ?? pickNumber(raw.confidence, 0.7),
    category: (row.category as PriorityAction["category"]) ?? (raw.category as PriorityAction["category"]) ?? "technical",
    evidence: readJsonRecord(raw.evidence)
  };
};

const serializeIntelligenceReport = (report: IntelligenceRecord["report"]) => {
  const {
    snapshot,
    featureVector,
    derivedFeature,
    detectedIssues,
    competitorSignals,
    marketPosition,
    priorityActions,
    implementationOutcomes,
    ...baseReport
  } = report;

  return {
    ...baseReport,
    relations: {
      featureVector,
      derivedFeature,
      detectedIssues,
      competitorSignals,
      marketPosition,
      priorityActions,
      implementationOutcomes
    }
  };
};

const parseDecisionFromReport = (report: IntelligenceReportGraph, healthTrend: number | null): IntelligenceDecisionViewPayload => {
  const metadata = {
    targetUrl: report.snapshot.url,
    projectName: report.snapshot.project.name,
    snapshotId: report.snapshotId,
    healthTrend
  };

  const derivedSignalsEnvelope = readJsonRecord(report.derivedFeature?.normalizedSignals);
  const normalizedSignals = readJsonRecord(derivedSignalsEnvelope.normalizedSignals) as unknown as NormalizedSignals;
  const derivedFeatures = readJsonRecord(report.derivedFeature?.derivedFeatures) as unknown as DerivedFeatures;

  const detectedIssues = report.detectedIssues.map(asDetectedIssue);
  const impactAssessments = detectedIssues.map((issue) => estimateImpact(issue));
  const priorityActions = report.priorityActions.map(asPriorityAction);

  const marketPositionRaw = readJsonRecord(report.marketPosition?.rawData);
  const marketPosition: MarketPositionResult = {
    ansoffPosition: String(marketPositionRaw.ansoffPosition ?? report.marketPosition?.ansoffPosition ?? "unknown"),
    porterPosition: String(marketPositionRaw.porterPosition ?? report.marketPosition?.porterStrategy ?? "unknown"),
    productMaturity: String(marketPositionRaw.productMaturity ?? report.marketPosition?.productMaturity ?? "unknown"),
    marketStrengthScore: pickNumber(marketPositionRaw.marketStrengthScore, report.marketPosition?.marketStrengthScore ?? 0)
  };

  const marketIntelligenceRaw = readJsonRecord(report.marketIntelligenceRaw);
  const roadmap = (marketIntelligenceRaw.roadmap as PrioritizedImprovementRoadmap | undefined) ?? {
    generatedAt: new Date(report.updatedAt).toISOString(),
    items: []
  };
  const executionBlueprints =
    (marketIntelligenceRaw.executionBlueprints as ExecutionBlueprint[] | undefined) ?? [];

  const competitiveIntelligenceRaw = readJsonRecord(report.competitiveIntelligence);
  const competitorGap = (competitiveIntelligenceRaw.competitorGap as CompetitorGapResult | null | undefined) ?? null;

  return {
    metadata,
    normalizedSignals,
    derivedFeatures,
    detectedIssues,
    impactAssessments,
    priorityActions,
    roadmap,
    executionBlueprints,
    competitorGap,
    marketPosition
  };
};

const buildChatActionCards = (message: string, actions: string[]): IntelligenceChatActionCard[] => {
  const cards: IntelligenceChatActionCard[] = [
    {
      id: "open-command-center",
      kind: "open_route",
      label: "Open Command Center",
      description: "Review live operating KPIs and active signals.",
      route: "/command-center"
    }
  ];

  const lower = message.toLowerCase();
  if (/(client|pipeline|sales|lead)/.test(lower)) {
    cards.push({
      id: "open-client-workflow",
      kind: "open_route",
      label: "Run Client Workflow",
      description: "Add client, score fit, generate pitch, log interaction, and set reminder.",
      route: "/clients/new"
    });
  }

  if (/(idea|product|launch|market)/.test(lower)) {
    cards.push({
      id: "open-idea-validator",
      kind: "open_route",
      label: "Run Idea Validator",
      description: "Execute multi-agent simulation before committing build scope.",
      route: "/products/idea-validator"
    });
  }

  if (/(risk|delivery|deadline|slip)/.test(lower)) {
    cards.push({
      id: "open-project-health",
      kind: "open_route",
      label: "Inspect Project Health",
      description: "Review at-risk projects and intervention actions.",
      route: "/projects"
    });
  }

  cards.push({
    id: "create-reminder",
    kind: "create_reminder",
    label: "Create AI Reminder",
    description: "Persist this recommendation as a reminder in the operating queue.",
    reminder: {
      title: `AI Action: ${(actions[0] ?? "Review command center priorities").slice(0, 92)}`,
      dueInHours: 24,
      type: "AI_ACTION"
    }
  });

  return cards.slice(0, 5);
};

const scoreByKeywordDensity = (text: string, positive: RegExp, negative: RegExp): number => {
  const lower = text.toLowerCase();
  const positiveHits = (lower.match(positive) ?? []).length;
  const negativeHits = (lower.match(negative) ?? []).length;
  return clamp(55 + positiveHits * 8 - negativeHits * 7);
};

const assessOpportunity = (input: OpportunityAssessmentInput): OpportunityAssessmentResult => {
  const narrative = `${input.idea} ${input.targetMarket} ${input.serviceFocus} ${(input.constraints ?? []).join(" ")}`;
  const launchWindow = input.launchWindowMonths ?? 12;

  const marketNeedScore = scoreByKeywordDensity(
    narrative,
    /(demand|growth|urgent|pain|compliance|automation|retention|conversion|efficiency|cost)/g,
    /(decline|shrinking|saturated|commodity|low interest)/g
  );

  const clientFitScore = scoreByKeywordDensity(
    `${input.targetMarket} ${input.serviceFocus}`,
    /(b2b|enterprise|agency|saas|platform|recurring|operations|workflow)/g,
    /(unclear|broad|generic|unknown)/g
  );

  const differentiationScore = scoreByKeywordDensity(
    input.idea,
    /(unique|specialized|vertical|integrated|real-time|predictive|automation|intelligence)/g,
    /(copy|clone|me-too|template)/g
  );

  const deliveryReadinessScore = clamp(82 - Math.max(launchWindow - 6, 0) * 3 + (input.constraints?.length ?? 0) * -1);
  const riskScore = clamp(
    scoreByKeywordDensity(
      narrative,
      /(dependency|regulation|legal|security|data quality|external api|single point|budget)/g,
      /(validated|existing clients|strong pipeline|clear scope)/g
    )
  );

  const overallScore = clamp(
    Math.round(
      marketNeedScore * 0.28 +
        clientFitScore * 0.24 +
        differentiationScore * 0.2 +
        deliveryReadinessScore * 0.18 +
        (100 - riskScore) * 0.1
    )
  );

  const decision: "GO" | "PILOT" | "HOLD" = overallScore >= 72 ? "GO" : overallScore >= 56 ? "PILOT" : "HOLD";

  const rationale: string[] = [
    `Market need score ${marketNeedScore}/100 based on demand and urgency signals.`,
    `Client fit score ${clientFitScore}/100 for target market and service alignment.`,
    `Differentiation score ${differentiationScore}/100 from uniqueness and specialization signals.`,
    `Delivery readiness score ${deliveryReadinessScore}/100 for launch window realism.`,
    `Risk score ${riskScore}/100; lower is better for immediate execution.`
  ];

  const marketScaleSeed = clamp(
    Math.round(
      marketNeedScore * 0.45 +
        clientFitScore * 0.3 +
        differentiationScore * 0.15 +
        Math.max(0, 100 - riskScore) * 0.1
    ),
    30,
    95
  );
  const launchAcceleration = clamp(24 - launchWindow, 0, 18) / 18;
  const tamMillions = Math.max(40, Math.round(120 + marketScaleSeed * 5.2));
  const samMillions = Math.max(12, Math.round(tamMillions * (0.18 + marketScaleSeed / 500)));
  const somMillions = Math.max(2, Math.round(samMillions * (0.08 + launchAcceleration * 0.1 + differentiationScore / 1000)));
  const benchmarkVerdict: OpportunityAssessmentResult["marketSizing"]["benchmarkVerdict"] =
    somMillions >= 35 ? "SCALABLE" : somMillions >= 16 ? "EMERGING" : "UNDERSIZED";
  const competitorPressure: OpportunityAssessmentResult["marketSizing"]["competitorPressure"] =
    differentiationScore >= 74 ? "LOW" : differentiationScore >= 58 ? "MEDIUM" : "HIGH";

  return {
    scorecard: {
      marketNeedScore,
      clientFitScore,
      differentiationScore,
      deliveryReadinessScore,
      riskScore,
      overallScore
    },
    decision,
    rationale,
    marketSizing: {
      tamMillions,
      samMillions,
      somMillions,
      benchmarkVerdict,
      competitorPressure
    },
    provenance: {
      method: "deterministic-rules-v1",
      generatedAt: new Date().toISOString(),
      confidence: clamp(Math.round((100 - riskScore * 0.45 + differentiationScore * 0.25) * 100) / 100, 35, 92)
    }
  };
};

const toIsoDay = (daysFromNow: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + Math.max(daysFromNow, 1));
  return date.toISOString();
};

const scoreClientCandidate = (
  input: ClientAcquisitionInput,
  candidate: ClientCandidateInput
): ClientAcquisitionAssessment["prioritizedAccounts"][number] => {
  const normalizedTargetIndustries = input.targetIndustries.map((value) => value.toLowerCase());
  const normalizedGeoFocus = (input.geoFocus ?? []).map((value) => value.toLowerCase());

  const matchedIndustry = normalizedTargetIndustries.some((industry) => candidate.industry.toLowerCase().includes(industry));
  const matchedGeoFocus =
    normalizedGeoFocus.length === 0
      ? true
      : normalizedGeoFocus.some((region) => (candidate.geography ?? "").toLowerCase().includes(region));

  const icpFitScore = clamp(
    50 +
      (matchedIndustry ? 28 : -8) +
      (matchedGeoFocus ? 12 : -6) +
      scoreByKeywordDensity(
        `${input.serviceProfile} ${candidate.painPoints.join(" ")}`,
        /(conversion|retention|automation|speed|scalability|pipeline|seo|revenue|lead)/g,
        /(unclear|no budget|low priority|later|unknown)/g
      ) * 0.12
  );

  const annualBudget = candidate.estimatedAnnualBudget ?? 0;
  const budgetFitScore = annualBudget <= 0 ? 52 : clamp(38 + Math.log10(Math.max(annualBudget, 1000)) * 12);

  const urgencyBase = candidate.urgencyLevel === "high" ? 84 : candidate.urgencyLevel === "medium" ? 68 : 54;
  const decisionWindowPenalty = Math.max((candidate.decisionWindowDays ?? 30) - 30, 0) * 0.45;
  const urgencyScore = clamp(urgencyBase - decisionWindowPenalty);

  const painSeverityScore = clamp(50 + Math.min(candidate.painPoints.length, 5) * 9);

  const winProbability = clamp(
    Math.round(icpFitScore * 0.37 + budgetFitScore * 0.2 + urgencyScore * 0.26 + painSeverityScore * 0.17)
  );

  const recommendation: "TAKE_NOW" | "NURTURE" | "PASS" =
    winProbability >= 74 ? "TAKE_NOW" : winProbability >= 56 ? "NURTURE" : "PASS";

  const primaryPain = candidate.painPoints[0] ?? "growth bottlenecks";
  const secondaryPain = candidate.painPoints[1] ?? "delivery inconsistency";
  const pitchAngles = [
    `Position Reex as a conversion and retention accelerator for ${candidate.accountName}.`,
    `Lead with a measurable fix for ${primaryPain} in the first 30 days.`,
    `Use a low-risk pilot tied to ${secondaryPain} and decision confidence gains.`
  ];

  const conversationScript = [
    `Opening: We studied ${candidate.accountName} and found fast wins around ${primaryPain}.`,
    `Probe: What is the current business cost of ${primaryPain} each month?`,
    `Pitch: We run an internal-first intelligence workflow and execute within your current stack.`,
    `Close: Can we align on a two-week pilot success metric before full rollout?`
  ];

  const followUpPlan = {
    primaryContactWindow: toIsoDay(recommendation === "TAKE_NOW" ? 2 : 4),
    secondFollowUp: toIsoDay(recommendation === "TAKE_NOW" ? 7 : 10),
    escalationCheck: toIsoDay(recommendation === "PASS" ? 21 : 14)
  };

  return {
    accountName: candidate.accountName,
    recommendation,
    scores: {
      icpFitScore,
      budgetFitScore,
      urgencyScore,
      painSeverityScore,
      winProbability
    },
    pitchAngles,
    conversationScript,
    followUpPlan,
    evidence: {
      matchedIndustry,
      matchedGeoFocus,
      topPainSignals: candidate.painPoints.slice(0, 3)
    }
  };
};

const assessClientAcquisition = (input: ClientAcquisitionInput): ClientAcquisitionAssessment => {
  const prioritizedAccounts = input.accounts
    .map((candidate) => scoreClientCandidate(input, candidate))
    .sort((a, b) => b.scores.winProbability - a.scores.winProbability);

  const takeNowCount = prioritizedAccounts.filter((account) => account.recommendation === "TAKE_NOW").length;
  const nurtureCount = prioritizedAccounts.filter((account) => account.recommendation === "NURTURE").length;
  const averageWinProbability =
    prioritizedAccounts.length === 0
      ? 0
      : Math.round(
          prioritizedAccounts.reduce((sum, account) => sum + account.scores.winProbability, 0) / prioritizedAccounts.length
        );

  const constraintsPenalty = Math.min((input.constraints ?? []).length * 1.7, 12);

  return {
    summary: {
      totalAccounts: prioritizedAccounts.length,
      takeNowCount,
      nurtureCount,
      averageWinProbability
    },
    prioritizedAccounts,
    provenance: {
      method: "deterministic-client-fit-v1",
      generatedAt: new Date().toISOString(),
      confidence: clamp(76 - constraintsPenalty + (takeNowCount > 0 ? 6 : -4), 45, 91)
    }
  };
};


export const analyzeWebsiteHandler = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const { url } = req.body;
  if (!url) {
    throw new ValidationError("URL is required.");
  }

  let project;
  try {
    const domain = new URL(url).hostname;
    project = await findProjectByDomainForUser(domain, user.id);
    if (!project) {
      project = await createProject({
        userId: user.id,
        name: domain,
        domain: domain,
        description: `Project for ${domain}`
      });
    }
  } catch (error) {
    throw new ValidationError("Invalid URL provided.");
  }

  const result = await orchestrateAnalysis(project.id, url, user.id);
  sendSuccess(res, result, result.message, result.status);
};

export const assessOpportunityHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = req.body as OpportunityAssessmentInput;
  const assessment = assessOpportunity(input);

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "opportunity-assessment",
        userId: user.id,
        status: "success",
        input: input as unknown as Prisma.InputJsonValue,
        output: assessment as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });

    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Opportunity assessment audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      assessment,
      audit
    },
    "Opportunity assessment generated."
  );
});

export const streamIdeaAnalysisHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = requireUser(req);
    const input = req.body as OpportunityAssessmentInput;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const sendEvent = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("started", {
      phase: "intake",
      generatedAt: new Date().toISOString(),
      provenance: {
        source: "live",
        confidence: 80,
        gaps: [] as string[]
      }
    });

    await wait(160);
    sendEvent("progress", {
      phase: "market-signal-evaluation",
      detail: "Evaluating market demand and target fit signals."
    });

    await wait(160);
    sendEvent("progress", {
      phase: "delivery-risk-evaluation",
      detail: "Scoring readiness, differentiation, and execution risk."
    });

    await wait(180);
    const assessment = assessOpportunity(input);

    let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
      logId: null,
      createdAt: null,
      persisted: false
    };

    try {
      const log = await prisma.agentLog.create({
        data: {
          agentName: "idea-validator-stream",
          userId: user.id,
          status: "success",
          input: input as unknown as Prisma.InputJsonValue,
          output: assessment as unknown as Prisma.InputJsonValue,
          executionTimeMs: 1,
          tokenUsage: 0
        }
      });

      audit = {
        logId: log.id,
        createdAt: log.createdAt,
        persisted: true
      };
    } catch (error) {
      logger.warn({ error, userId: user.id }, "Idea validator stream audit log persistence failed.");
    }

    sendEvent("completed", {
      assessment,
      audit,
      provenance: {
        method: "sse-opportunity-stream-v1",
        source: "live",
        retrievedAt: new Date().toISOString(),
        confidence: assessment.provenance.confidence,
        gaps: [] as string[]
      }
    });

    res.end();
  } catch (error) {
    if (!res.headersSent) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Idea streaming failed.";
    res.write("event: error\\n");
    res.write(`data: ${JSON.stringify({ message })}\\n\\n`);
    res.end();
  }
};

export const getOpportunityHistoryHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const query = req.query as { limit?: string | number };
  const limit = clamp(Number(query.limit ?? 8), 1, 25);

  const logs = await prisma.agentLog.findMany({
    where: {
      userId: user.id,
      agentName: "opportunity-assessment"
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  const history = logs.map((log) => {
    const output = (log.output ?? {}) as Record<string, unknown>;
    const scorecard = (output.scorecard ?? null) as OpportunityAssessmentResult["scorecard"] | null;
    const decision = (output.decision ?? null) as OpportunityAssessmentResult["decision"] | null;
    const rationale = Array.isArray(output.rationale) ? (output.rationale as string[]) : [];
    const provenance = (output.provenance ?? {}) as OpportunityAssessmentResult["provenance"] | Record<string, unknown>;
    const confidence = typeof provenance.confidence === "number" ? provenance.confidence : null;

    return {
      logId: log.id,
      createdAt: log.createdAt,
      decision,
      scorecard,
      confidence,
      rationale,
      status: log.status
    };
  });

  const gaps: string[] = [];
  if (history.length === 0) {
    gaps.push("No opportunity assessments found.");
  }

  sendSuccess(
    res,
    {
      summary: {
        total: history.length,
        lastDecision: history[0]?.decision ?? null,
        lastScore: history[0]?.scorecard?.overallScore ?? null,
        lastAssessedAt: history[0]?.createdAt ?? null
      },
      history,
      provenance: {
        method: "agent-log-history-v1",
        source: history.length > 0 ? "live" : "fallback",
        retrievedAt: new Date().toISOString(),
        confidence: clamp(55 + history.length * 4, 45, 90),
        gaps
      } satisfies IntelligenceProvenance
    },
    "Opportunity assessment history fetched."
  );
});

export const assessClientAcquisitionHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = req.body as ClientAcquisitionInput;
  const assessment = assessClientAcquisition(input);

  let briefingAudit: { briefingId: string | null; generatedAt: Date | null; persisted: boolean } = {
    briefingId: null,
    generatedAt: null,
    persisted: false
  };

  let logAudit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const briefing = await prisma.clientBriefing.create({
      data: {
        clientId: user.id,
        executiveSummary: `Client acquisition assessment generated for ${assessment.summary.totalAccounts} target accounts with ${assessment.summary.takeNowCount} TAKE_NOW recommendations.`,
        opportunities: assessment.prioritizedAccounts as unknown as Prisma.InputJsonValue,
        scores: {
          summary: assessment.summary,
          confidence: assessment.provenance.confidence,
          revenueGoalQuarter: input.revenueGoalQuarter ?? null
        } as Prisma.InputJsonValue,
        benchmarkData: {
          targetIndustries: input.targetIndustries,
          geoFocus: input.geoFocus ?? [],
          constraints: input.constraints ?? []
        } as Prisma.InputJsonValue,
        internalNotes: `Service profile: ${input.serviceProfile}`
      }
    });

    briefingAudit = {
      briefingId: briefing.id,
      generatedAt: briefing.generatedAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Client acquisition briefing persistence failed.");
  }

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "client-acquisition-assessment",
        userId: user.id,
        status: "success",
        input: input as unknown as Prisma.InputJsonValue,
        output: assessment as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });

    logAudit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Client acquisition agent log persistence failed.");
  }

  sendSuccess(
    res,
    {
      assessment,
      audit: {
        briefing: briefingAudit,
        agentLog: logAudit
      }
    },
    "Client acquisition assessment generated."
  );
});

const summarizeAdaptiveScoring = async (userId: string) => {
  const outcomes = await prisma.prospectOutcome.findMany({
    where: { prospectId: { startsWith: `${userId}:` } },
    orderBy: { closedAt: "desc" },
    take: 25
  });

  if (outcomes.length === 0) {
    return {
      sampleSize: 0,
      winRate: 0,
      avgDealSize: 0,
      topWinFactors: [] as string[],
      topLossReasons: [] as string[],
      scoringAdjustments: ["Collect at least 5 closed outcomes before adjusting weights."]
    };
  }

  const wins = outcomes.filter((item) => item.outcome === "CLOSED_WON");
  const losses = outcomes.filter((item) => item.outcome === "CLOSED_LOST");

  const avgDealSize =
    wins.length === 0
      ? 0
      : Math.round(wins.reduce((sum, item) => sum + (item.dealSize ?? 0), 0) / Math.max(wins.length, 1));

  const winFactors = wins
    .map((item) => item.winFactor)
    .filter((value): value is string => Boolean(value))
    .slice(0, 5);

  const lossReasons = losses
    .map((item) => item.lossReason)
    .filter((value): value is string => Boolean(value))
    .slice(0, 5);

  const winRate = Math.round((wins.length / outcomes.length) * 100);

  const scoringAdjustments: string[] = [];
  if (winRate < 40) {
    scoringAdjustments.push("Increase urgency and budget thresholds before TAKE_NOW recommendations.");
  }
  if (winRate >= 60) {
    scoringAdjustments.push("Maintain current ICP fit thresholds and scale outbound volume by 20%.");
  }
  if (lossReasons.some((reason) => /budget|price/i.test(reason))) {
    scoringAdjustments.push("Add price-objection handling script earlier in first call.");
  }
  if (winFactors.some((factor) => /speed|delivery|timeline/i.test(factor))) {
    scoringAdjustments.push("Prioritize fast-delivery proof points in opening pitch angles.");
  }
  if (scoringAdjustments.length === 0) {
    scoringAdjustments.push("No major adaptation needed; continue collecting outcomes for stronger signal.");
  }

  return {
    sampleSize: outcomes.length,
    winRate,
    avgDealSize,
    topWinFactors: winFactors,
    topLossReasons: lossReasons,
    scoringAdjustments
  };
};

const buildProjectHealthInsights = async (projectId: string, userId: string) => {
  const reports = await prisma.intelligenceReport.findMany({
    where: {
      snapshot: {
        projectId,
        project: {
          userId
        }
      },
      status: "completed"
    },
    orderBy: { createdAt: "desc" },
    take: 12,
    include: {
      priorityActions: {
        orderBy: { priorityScore: "desc" },
        take: 5
      },
      snapshot: {
        select: {
          id: true,
          createdAt: true
        }
      }
    }
  });

  const latest = reports[0] ?? null;
  const previous = reports[1] ?? null;

  const latestScore = latest?.overallScore ?? null;
  const trendPulse = latestScore !== null && previous?.overallScore !== null ? latestScore - previous.overallScore : null;

  const featureUpdateRecommendations =
    latest?.priorityActions.map((item) => ({
      recommendation: item.recommendation,
      issueType: item.issueType,
      priorityScore: item.priorityScore,
      confidence: item.confidence ?? 0.6
    })) ?? [];

  const threeWay = await prisma.threeWayScore.findUnique({ where: { projectId } });
  const renewalSignals = {
    clientRenewed: threeWay?.clientRenewed ?? false,
    referralGenerated: threeWay?.referralGenerated ?? false,
    clientScore: threeWay?.clientScore ?? null,
    lowestDimension: threeWay?.lowestDimension ?? null
  };

  const riskSignals: string[] = [];
  const dataGaps: string[] = [];

  if (reports.length === 0) {
    dataGaps.push("No completed intelligence reports were found for this project.");
  }
  if (!threeWay) {
    dataGaps.push("Three-way score record is missing; renewal signal confidence is reduced.");
  }

  if (latestScore !== null && latestScore < 60) {
    riskSignals.push("Latest intelligence score is below 60.");
  }
  if (trendPulse !== null && trendPulse < -8) {
    riskSignals.push("Project health declined significantly compared to previous snapshot.");
  }
  if (!renewalSignals.clientRenewed) {
    riskSignals.push("Client renewal signal not yet observed.");
  }

  const generatedAt = new Date().toISOString();
  const source: IntelligenceProvenance["source"] = reports.length > 0 ? (dataGaps.length > 0 ? "mixed" : "live") : "fallback";

  return {
    projectId,
    snapshotCount: reports.length,
    latestScore,
    trendPulse,
    generatedAt,
    featureUpdateRecommendations,
    renewalSignals,
    riskSignals,
    provenance: {
      method: "deterministic-project-health-v1",
      source,
      retrievedAt: generatedAt,
      confidence: clamp(65 + (reports.length >= 3 ? 12 : 0) - (riskSignals.length > 1 ? 8 : 0), 40, 90),
      gaps: dataGaps
    }
  };
};

export const captureClientOutcomeHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = req.body as {
    prospectId: string;
    outcome: "CLOSED_WON" | "CLOSED_LOST" | "NO_DECISION";
    dealSize?: number;
    serviceType?: string;
    lossReason?: string;
    winFactor?: string;
    prospectScore?: number;
    closedAt?: string;
  };

  const scopedProspectId = `${user.id}:${input.prospectId}`;

  const record = await prisma.prospectOutcome.create({
    data: {
      prospectId: scopedProspectId,
      outcome: input.outcome,
      dealSize: input.dealSize,
      serviceType: input.serviceType,
      lossReason: input.lossReason,
      winFactor: input.winFactor,
      prospectScore: input.prospectScore,
      closedAt: input.closedAt ? new Date(input.closedAt) : new Date()
    }
  });

  const adaptiveSummary = await summarizeAdaptiveScoring(user.id);
  const outcomeGaps: string[] = [];
  if (adaptiveSummary.sampleSize < 5) {
    outcomeGaps.push("Adaptive scoring sample size is below 5 outcomes.");
  }

  sendSuccess(
    res,
    {
      recordedOutcome: {
        id: record.id,
        prospectId: input.prospectId,
        outcome: record.outcome,
        closedAt: record.closedAt
      },
      adaptiveSummary,
      provenance: {
        method: "deterministic-adaptive-feedback-v1",
        source: "live",
        retrievedAt: new Date().toISOString(),
        confidence: clamp(45 + adaptiveSummary.sampleSize * 4, 45, 92),
        gaps: outcomeGaps
      } satisfies IntelligenceProvenance
    },
    "Client outcome captured."
  );
});

export const getProjectHealthSignalsHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const projectId = String(req.params.projectId);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, name: true }
  });

  if (!project) {
    throw new NotFoundError("Project not found.");
  }

  if (!canReadProject(user.role, project.userId, user.id)) {
    throw new UnauthorizedError("You are not allowed to access this project health report.");
  }

  const health = await buildProjectHealthInsights(projectId, project.userId);

  sendSuccess(
    res,
    {
      project: {
        id: project.id,
        name: project.name
      },
      health
    },
    "Project health signals fetched."
  );
});

export const getWeeklyOperatingReviewHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);

  const [opportunityLogs, clientLogs, adaptiveSummary, projects] = await Promise.all([
    prisma.agentLog.count({ where: { userId: user.id, agentName: "opportunity-assessment" } }),
    prisma.agentLog.count({ where: { userId: user.id, agentName: "client-acquisition-assessment" } }),
    summarizeAdaptiveScoring(user.id),
    prisma.project.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
      take: 5
    })
  ]);

  const healthByProject = await Promise.all(projects.map((project) => buildProjectHealthInsights(project.id, user.id)));

  const averageProjectScore =
    healthByProject.length === 0
      ? null
      : Math.round(
          healthByProject.reduce((sum, item) => sum + (item.latestScore ?? 0), 0) / Math.max(healthByProject.length, 1)
        );

  const atRiskProjects = healthByProject
    .filter((item) => item.riskSignals.length > 0)
    .map((item) => ({ projectId: item.projectId, riskSignals: item.riskSignals.slice(0, 2) }));

  const reviewGaps: string[] = [];
  if (projects.length === 0) {
    reviewGaps.push("No projects found for this user; Loop 3 KPIs are limited.");
  }
  if (adaptiveSummary.sampleSize < 5) {
    reviewGaps.push("Loop 2 adaptive sample size is low; win-rate confidence is limited.");
  }

  const generatedAt = new Date().toISOString();
  const source: IntelligenceProvenance["source"] =
    healthByProject.length > 0 ? (reviewGaps.length > 0 ? "mixed" : "live") : "fallback";

  sendSuccess(
    res,
    {
      generatedAt,
      kpis: {
        loop1OpportunityAssessments: opportunityLogs,
        loop2ClientAssessments: clientLogs,
        loop2WinRate: adaptiveSummary.winRate,
        loop3AverageProjectScore: averageProjectScore
      },
      loop2AdaptiveSummary: adaptiveSummary,
      loop3ProjectHealth: healthByProject,
      atRiskProjects,
      provenance: {
        method: "deterministic-weekly-operating-review-v1",
        source,
        retrievedAt: generatedAt,
        confidence: clamp(55 + healthByProject.length * 5 + Math.min(adaptiveSummary.sampleSize, 10), 45, 93),
        gaps: reviewGaps
      } satisfies IntelligenceProvenance
    },
    "Weekly operating review generated."
  );
});

export const getDailyBriefingHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const since7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [opportunityCount7d, clientAssessments7d, outcomes7d, projects] = await Promise.all([
    prisma.agentLog.count({
      where: {
        userId: user.id,
        agentName: { in: ["opportunity-assessment", "idea-validator-stream"] },
        createdAt: { gte: since7Days }
      }
    }),
    prisma.agentLog.count({
      where: {
        userId: user.id,
        agentName: "client-acquisition-assessment",
        createdAt: { gte: since7Days }
      }
    }),
    prisma.prospectOutcome.count({
      where: {
        prospectId: { startsWith: `${user.id}:` },
        createdAt: { gte: since7Days }
      }
    }),
    prisma.project.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
      take: 8
    })
  ]);

  const projectHealth = await Promise.all(
    projects.map((project: { id: string; name: string }) => buildProjectHealthInsights(project.id, user.id))
  );
  type ProjectHealthResult = Awaited<ReturnType<typeof buildProjectHealthInsights>>;
  const atRiskProjects = projectHealth.filter((health: ProjectHealthResult) => health.riskSignals.length > 0);
  const averageProjectScore =
    projectHealth.length === 0
      ? null
      : Math.round(
          projectHealth.reduce((sum: number, item: ProjectHealthResult) => sum + (item.latestScore ?? 0), 0) /
            projectHealth.length
        );

  const topRisks: string[] = [];
  if (atRiskProjects.length > 0) {
    topRisks.push(`${atRiskProjects.length} projects have active risk signals.`);
  }
  if (outcomes7d === 0) {
    topRisks.push("No client outcomes were captured in the last 7 days.");
  }
  if (projectHealth.length === 0) {
    topRisks.push("No active projects found; delivery visibility is limited.");
  }

  const topOpportunities: string[] = [];
  if (opportunityCount7d > 0) {
    topOpportunities.push(`${opportunityCount7d} opportunity assessments were run in the last 7 days.`);
  }
  if (clientAssessments7d > 0) {
    topOpportunities.push(`${clientAssessments7d} client assessments can be converted into outreach actions.`);
  }
  if (averageProjectScore !== null && averageProjectScore >= 70) {
    topOpportunities.push("Current delivery health supports a stronger growth push this week.");
  }

  const momentum: DailyBriefingResult["overview"]["momentum"] =
    atRiskProjects.length >= 3 || (averageProjectScore !== null && averageProjectScore < 55)
      ? "AT_RISK"
      : opportunityCount7d + clientAssessments7d >= 4
        ? "STRONG"
        : "STEADY";

  const briefingGaps: string[] = [];
  if (projectHealth.length === 0) {
    briefingGaps.push("Project health data unavailable for this user.");
  }
  if (opportunityCount7d === 0 && clientAssessments7d === 0) {
    briefingGaps.push("No recent intelligence assessments found in last 7 days.");
  }

  const generatedAt = new Date().toISOString();
  const source: IntelligenceProvenance["source"] = briefingGaps.length > 0 ? "mixed" : "live";

  const briefing: DailyBriefingResult = {
    generatedAt,
    overview: {
      momentum,
      headline:
        momentum === "AT_RISK"
          ? "Execution risks need intervention today."
          : momentum === "STRONG"
            ? "Pipeline and delivery signals support growth moves today."
            : "Operating signals are stable with selective priorities."
    },
    signals: {
      ceo: {
        signal: `${opportunityCount7d} opportunity validations and ${clientAssessments7d} client assessments this week.`,
        riskLevel: momentum === "AT_RISK" ? "HIGH" : momentum === "STEADY" ? "MEDIUM" : "LOW",
        nextAction: "Review top 3 priorities and align owner deadlines before noon."
      },
      product: {
        signal: `${averageProjectScore ?? "N/A"} average delivery score across ${projectHealth.length} projects.`,
        riskLevel:
          averageProjectScore === null ? "MEDIUM" : averageProjectScore < 58 ? "HIGH" : averageProjectScore < 72 ? "MEDIUM" : "LOW",
        nextAction: "Address the highest-risk project recommendation and lock this sprint's scope."
      },
      sales: {
        signal: `${outcomes7d} recorded client outcomes in the last 7 days.`,
        riskLevel: outcomes7d === 0 ? "HIGH" : outcomes7d < 2 ? "MEDIUM" : "LOW",
        nextAction: "Convert top TAKE_NOW leads into scheduled calls and log outcomes immediately."
      },
      marketing: {
        signal: `${opportunityCount7d} validated opportunities can be used as campaign themes.`,
        riskLevel: opportunityCount7d === 0 ? "MEDIUM" : "LOW",
        nextAction: "Publish one proof-backed narrative tied to this week's top opportunity signal."
      },
      delivery: {
        signal: `${atRiskProjects.length} projects currently flagged with delivery risks.`,
        riskLevel: atRiskProjects.length >= 3 ? "HIGH" : atRiskProjects.length > 0 ? "MEDIUM" : "LOW",
        nextAction: "Run intervention check-ins for at-risk projects and update mitigation owners today."
      }
    },
    topRisks: topRisks.slice(0, 5),
    topOpportunities: topOpportunities.slice(0, 5),
    provenance: {
      method: "deterministic-daily-briefing-v1",
      source,
      retrievedAt: generatedAt,
      confidence: clamp(58 + projectHealth.length * 4 + Math.min(opportunityCount7d + clientAssessments7d, 8), 42, 92),
      gaps: briefingGaps
    }
  };

  sendSuccess(res, briefing, "Daily briefing generated.");
});

export const getIntelligenceInsightsHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const query = req.query as { limit?: string | number };
  const limit = clamp(Number(query.limit ?? 8), 1, 20);
  const since14Days = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const logs = await prisma.agentLog.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: since14Days },
      status: "success"
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  const readStateLogs = await prisma.agentLog.findMany({
    where: {
      userId: user.id,
      agentName: "insight-read-state"
    },
    orderBy: { createdAt: "desc" },
    take: 400
  });

  const readStateByInsightId = new Map<string, boolean>();
  for (const log of readStateLogs) {
    const input = (log.input ?? {}) as Record<string, unknown>;
    const insightId = typeof input.insightId === "string" ? input.insightId : null;
    const isRead = typeof input.isRead === "boolean" ? input.isRead : null;
    if (!insightId || isRead === null) {
      continue;
    }
    if (!readStateByInsightId.has(insightId)) {
      readStateByInsightId.set(insightId, isRead);
    }
  }

  const insights: IntelligenceInsightFeedItem[] = logs.map((log) => {
    const output = (log.output ?? {}) as Record<string, unknown>;
    const recommendation = typeof output.recommendation === "string" ? output.recommendation : null;
    const rationale = Array.isArray(output.rationale) ? (output.rationale as string[]).filter((item) => typeof item === "string") : [];
    const summary = recommendation ?? rationale[0] ?? `Recent ${log.agentName} execution completed.`;

    const lowerAgent = log.agentName.toLowerCase();
    const category: IntelligenceInsightFeedItem["category"] =
      lowerAgent.includes("risk") || lowerAgent.includes("monitor")
        ? "risk"
        : lowerAgent.includes("opportunity") || lowerAgent.includes("forecast")
          ? "opportunity"
          : "recommendation";

    const priority: IntelligenceInsightFeedItem["priority"] =
      category === "risk" ? "HIGH" : category === "opportunity" ? "MEDIUM" : "LOW";

    return {
      id: log.id,
      title: log.agentName.replace(/-/g, " "),
      summary,
      category,
      priority,
      generatedAt: log.createdAt.toISOString(),
      sourceAgent: log.agentName,
      isRead: readStateByInsightId.get(log.id) ?? false
    };
  });

  const generatedAt = new Date().toISOString();
  const gaps: string[] = [];
  if (insights.length === 0) {
    gaps.push("No successful intelligence runs found in the last 14 days.");
  }

  sendSuccess(
    res,
    {
      generatedAt,
      total: insights.length,
      unreadCount: insights.filter((item) => !item.isRead).length,
      insights,
      provenance: {
        method: "agent-log-insights-feed-v1",
        source: insights.length > 0 ? "live" : "fallback",
        retrievedAt: generatedAt,
        confidence: clamp(48 + insights.length * 5, 40, 89),
        gaps
      } satisfies IntelligenceProvenance
    },
    "Intelligence insight feed generated."
  );
});

export const setIntelligenceInsightReadStateHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const insightId = String(req.params.insightId ?? "").trim();
  const isRead = Boolean((req.body as { isRead?: boolean } | undefined)?.isRead ?? true);

  if (!insightId) {
    throw new ValidationError("insightId is required.");
  }

  const insightLog = await prisma.agentLog.findFirst({
    where: {
      id: insightId,
      userId: user.id
    },
    select: { id: true }
  });

  if (!insightLog) {
    throw new NotFoundError("Insight item not found.");
  }

  await prisma.agentLog.create({
    data: {
      agentName: "insight-read-state",
      userId: user.id,
      status: "success",
      input: {
        insightId,
        isRead
      } as Prisma.InputJsonValue,
      output: {
        action: "set-read-state"
      } as Prisma.InputJsonValue,
      executionTimeMs: 1,
      tokenUsage: 0
    }
  });

  const updatedAt = new Date().toISOString();
  sendSuccess(
    res,
    {
      insightId,
      isRead,
      updatedAt,
      provenance: {
        method: "insight-read-state-log-v1",
        source: "live",
        retrievedAt: updatedAt,
        confidence: 88,
        gaps: [] as string[]
      } satisfies IntelligenceProvenance
    },
    isRead ? "Insight marked as read." : "Insight marked as unread."
  );
});

export const streamIntelligenceChatHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = requireUser(req);
    const input = req.body as IntelligenceChatStreamInput;
    const message = input.message.trim();

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const sendEvent = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("started", {
      phase: "context-bootstrap",
      generatedAt: new Date().toISOString(),
      provenance: {
        source: "live",
        confidence: 78,
        gaps: [] as string[]
      }
    });

    await wait(120);
    sendEvent("progress", {
      phase: "signal-scan",
      detail: "Scanning recent intelligence actions and operating signals."
    });

    await wait(120);
    sendEvent("progress", {
      phase: "executive-manager",
      detail: "Running executive manager orchestration across live company context."
    });

    let responseText = "";
    let actions: string[] = [];
    let confidence = 73;
    let responseMethod = "deterministic-intelligence-chat-stream-v1";
    let responseSource: "live" | "mixed" | "fallback" = "fallback";
    let model = "deterministic";
    let gaps: string[] = [];

    const managerResult = await generateExecutiveManagerResponse(user.id, message, input.context);
    if (managerResult) {
      responseText = managerResult.response;
      actions = managerResult.actions.length > 0
        ? managerResult.actions
        : ["Review live project and client signals, then execute one high-confidence action now."];
      confidence = managerResult.confidence;
      responseMethod = "llm-executive-manager-orchestrator-v1";
      responseSource = managerResult.source;
      model = managerResult.model;
      gaps = managerResult.gaps;
    } else {
      const lower = message.toLowerCase();
      if (/(risk|delivery|deadline|slip)/.test(lower)) {
        actions.push("Prioritize a delivery-risk intervention list in Command Centre today.");
      }
      if (/(pipeline|client|sales|lead)/.test(lower)) {
        actions.push("Review TAKE_NOW accounts and schedule 3 follow-up calls in the next 24 hours.");
      }
      if (/(idea|product|launch|market)/.test(lower)) {
        actions.push("Run opportunity stream for your top concept and compare TAM/SAM/SOM before committing build scope.");
      }
      if (actions.length === 0) {
        actions.push("Start with Daily Briefing, then execute one high-confidence opportunity or delivery action.");
      }

      responseText = [
        "Operational answer:",
        `- Focus: ${actions[0]}`,
        `- Secondary: ${actions[1] ?? "Align owners and due dates in a single execution board."}`,
        "- Guardrail: mark all insight actions as read/unread to preserve decision traceability."
      ].join("\n");
      gaps = ["Executive manager LLM unavailable; deterministic fallback used."];
    }
    const actionCards = buildChatActionCards(message, actions);

    try {
      await prisma.agentLog.create({
        data: {
          agentName: "intelligence-chat-stream",
          userId: user.id,
          status: "success",
          input: { message, context: input.context ?? null } as Prisma.InputJsonValue,
          output: { response: responseText, actions, actionCards, confidence, method: responseMethod, model, gaps } as Prisma.InputJsonValue,
          executionTimeMs: 1,
          tokenUsage: 0
        }
      });
    } catch (error) {
      logger.warn({ error, userId: user.id }, "Intelligence chat stream audit log persistence failed.");
    }

    sendEvent("completed", {
      response: responseText,
      actions,
      actionCards,
      confidence,
      model,
      provenance: {
        method: responseMethod,
        source: responseSource,
        retrievedAt: new Date().toISOString(),
        confidence,
        gaps
      }
    });

    res.end();
  } catch (error) {
    if (!res.headersSent) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Intelligence chat streaming failed.";
    res.write("event: error\\n");
    res.write(`data: ${JSON.stringify({ message })}\\n\\n`);
    res.end();
  }
};

export const generateProductRoadmapHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = (req.body ?? {}) as ProductRoadmapInput;
  const planningHorizonWeeks = clamp(Math.round(input.planningHorizonWeeks ?? 12), 4, 26);
  const maxInitiatives = clamp(Math.round(input.maxInitiatives ?? 5), 2, 10);
  const strategicTheme = input.strategicTheme?.trim() ?? "";
  const since60Days = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  const [projects, adaptiveSummary, recentActions, implementationOutcomes] = await Promise.all([
    prisma.project.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
      take: 12
    }),
    summarizeAdaptiveScoring(user.id),
    prisma.priorityActionRecord.findMany({
      where: {
        createdAt: { gte: since60Days },
        snapshot: {
          project: {
            userId: user.id
          }
        }
      },
      select: {
        issueType: true,
        recommendation: true,
        impactScore: true,
        priorityScore: true,
        confidence: true,
        snapshot: {
          select: {
            projectId: true
          }
        }
      },
      orderBy: [{ priorityScore: "desc" }, { createdAt: "desc" }],
      take: 80
    }),
    prisma.implementationOutcomeRecord.findMany({
      where: {
        createdAt: { gte: since60Days },
        project: {
          userId: user.id
        }
      },
      select: {
        implementationStatus: true,
        observedImprovement: true,
        predictedImprovement: true,
        recommendationTitle: true
      },
      orderBy: { createdAt: "desc" },
      take: 50
    })
  ]);

  const healthByProject = await Promise.all(projects.map((project) => buildProjectHealthInsights(project.id, user.id)));

  const issueAggregation = new Map<
    string,
    {
      issueType: string;
      recommendation: string;
      sourceProjectIds: Set<string>;
      sourceActionCount: number;
      totalPriorityScore: number;
      totalImpactScore: number;
      totalConfidence: number;
    }
  >();

  for (const action of recentActions) {
    const key = `${action.issueType}::${action.recommendation}`;
    const existing =
      issueAggregation.get(key) ??
      {
        issueType: action.issueType,
        recommendation: action.recommendation,
        sourceProjectIds: new Set<string>(),
        sourceActionCount: 0,
        totalPriorityScore: 0,
        totalImpactScore: 0,
        totalConfidence: 0
      };

    existing.sourceActionCount += 1;
    existing.totalPriorityScore += action.priorityScore;
    existing.totalImpactScore += action.impactScore;
    existing.totalConfidence += action.confidence ?? 0.65;
    if (action.snapshot.projectId) {
      existing.sourceProjectIds.add(action.snapshot.projectId);
    }

    issueAggregation.set(key, existing);
  }

  const rankedInitiatives = Array.from(issueAggregation.values())
    .map((item) => {
      const averagePriorityScore = item.totalPriorityScore / Math.max(item.sourceActionCount, 1);
      const averageImpactScore = item.totalImpactScore / Math.max(item.sourceActionCount, 1);
      const averageConfidence = item.totalConfidence / Math.max(item.sourceActionCount, 1);
      const rankingScore =
        averagePriorityScore * 0.5 + averageImpactScore * 0.35 + Math.min(item.sourceActionCount, 6) * 0.12;
      return {
        ...item,
        averagePriorityScore,
        averageImpactScore,
        averageConfidence,
        rankingScore
      };
    })
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .slice(0, maxInitiatives);

  const atRiskProjects = healthByProject.filter((item) => item.riskSignals.length > 0).length;
  const averageProjectScore =
    healthByProject.length === 0
      ? 52
      : Math.round(
          healthByProject.reduce((sum, item) => sum + (item.latestScore ?? 52), 0) / Math.max(healthByProject.length, 1)
        );

  const completedOutcomes = implementationOutcomes.filter((row) => /completed|done|shipped/i.test(row.implementationStatus));
  const stalledOutcomes = implementationOutcomes.filter((row) => /blocked|stalled|delayed|deferred/i.test(row.implementationStatus));

  const learningAdjustments: string[] = [];
  if (stalledOutcomes.length > completedOutcomes.length && implementationOutcomes.length > 0) {
    learningAdjustments.push("Reduce concurrent roadmap initiatives and enforce stricter WIP limits.");
  }
  if (adaptiveSummary.winRate < 50) {
    learningAdjustments.push("Prioritize initiatives with direct conversion impact until win-rate recovers above 50%.");
  }
  if (atRiskProjects >= Math.max(2, Math.round(projects.length * 0.4))) {
    learningAdjustments.push("Allocate one initiative slot to reliability and delivery stability improvements.");
  }
  if (learningAdjustments.length === 0) {
    learningAdjustments.push("Maintain current roadmap weighting and re-evaluate with next weekly operating review.");
  }

  const initiatives: ProductRoadmapResult["initiatives"] = rankedInitiatives.map((item, index) => {
    const priorityBand: "NOW" | "NEXT" | "LATER" =
      index < 2 ? "NOW" : index < Math.min(5, maxInitiatives) ? "NEXT" : "LATER";

    const owner: "product" | "engineering" | "growth" =
      /conversion|messaging|content|pipeline|onboarding/i.test(item.issueType) ? "growth" :
      /performance|security|stability|technical|architecture/i.test(item.issueType) ? "engineering" :
      "product";

    const baseTimeline = priorityBand === "NOW" ? 2 : priorityBand === "NEXT" ? 4 : 6;
    const timelineWeeks = clamp(Math.round(baseTimeline + Math.max(1 - item.averagePriorityScore, 0) * 4), 2, planningHorizonWeeks);

    return {
      title: `${item.issueType.replace(/[_-]/g, " ")} improvement initiative`,
      issueType: item.issueType,
      recommendation: item.recommendation,
      priorityBand,
      expectedImpactScore: clamp(Math.round(item.averageImpactScore * 100), 0, 100),
      confidence: clamp(Math.round(item.averageConfidence * 100), 0, 100),
      timelineWeeks,
      owner,
      rationale: [
        `Observed ${item.sourceActionCount} high-priority actions across recent project intelligence runs.`,
        `Average priority score ${item.averagePriorityScore.toFixed(2)} and impact score ${item.averageImpactScore.toFixed(2)}.`
      ],
      evidence: {
        sourceProjectIds: Array.from(item.sourceProjectIds).slice(0, 5),
        sourceActionCount: item.sourceActionCount,
        averagePriorityScore: Math.round(item.averagePriorityScore * 100) / 100
      }
    };
  });

  const roadmapGaps: string[] = [];
  if (projects.length === 0) {
    roadmapGaps.push("No projects found; roadmap recommendations are fallback-only.");
  }
  if (recentActions.length === 0) {
    roadmapGaps.push("No recent priority actions found in the last 60 days.");
  }
  if (implementationOutcomes.length < 3) {
    roadmapGaps.push("Implementation outcome history is sparse; adaptation confidence is reduced.");
  }

  const generatedAt = new Date().toISOString();
  const roadmap: ProductRoadmapResult = {
    generatedAt,
    planningHorizonWeeks,
    strategicTheme: strategicTheme.length > 0 ? strategicTheme : null,
    signalSummary: {
      analyzedProjects: projects.length,
      atRiskProjects,
      averageProjectScore,
      adaptiveWinRate: adaptiveSummary.winRate,
      implementationOutcomeCount: implementationOutcomes.length
    },
    initiatives,
    learningAdjustments,
    provenance: {
      method: "deterministic-product-roadmap-v1",
      source: initiatives.length > 0 ? (roadmapGaps.length > 0 ? "mixed" : "live") : "fallback",
      retrievedAt: generatedAt,
      confidence: clamp(56 + initiatives.length * 5 + Math.round(adaptiveSummary.winRate * 0.1), 45, 93),
      gaps: roadmapGaps
    }
  };

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "product-roadmap-weekly",
        userId: user.id,
        status: "success",
        input: (input as unknown as Prisma.InputJsonValue) ?? ({} as Prisma.InputJsonValue),
        output: roadmap as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });
    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Product roadmap audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      roadmap,
      audit
    },
    "Product roadmap recommendations generated."
  );
});

export const captureRoadmapOutcomeHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = req.body as RoadmapOutcomeCaptureInput;

  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      userId: user.id
    },
    select: {
      id: true,
      name: true
    }
  });

  if (!project) {
    throw new NotFoundError("Project not found.");
  }

  const record = await prisma.implementationOutcomeRecord.create({
    data: {
      projectId: project.id,
      recommendationTitle: input.recommendationTitle,
      implementationStatus: input.implementationStatus,
      predictedImprovement: input.predictedImprovement,
      observedImprovement: input.observedImprovement,
      learningScore: input.learningScore,
      rawData: {
        note: input.note ?? null,
        source: "roadmap-outcome-capture-v1"
      }
    }
  });

  const since90Days = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [projectOutcomes, userOutcomes] = await Promise.all([
    prisma.implementationOutcomeRecord.findMany({
      where: {
        projectId: project.id,
        createdAt: { gte: since90Days }
      },
      select: {
        implementationStatus: true,
        observedImprovement: true,
        predictedImprovement: true
      },
      orderBy: { createdAt: "desc" },
      take: 80
    }),
    prisma.implementationOutcomeRecord.findMany({
      where: {
        createdAt: { gte: since90Days },
        project: {
          userId: user.id
        }
      },
      select: {
        implementationStatus: true,
        observedImprovement: true,
        predictedImprovement: true
      },
      orderBy: { createdAt: "desc" },
      take: 160
    })
  ]);

  const isCompleted = (status: string): boolean => /completed|done|shipped/i.test(status);
  const isStalled = (status: string): boolean => /blocked|stalled|delayed|deferred|cancelled/i.test(status);

  const projectCompleted = projectOutcomes.filter((row) => isCompleted(row.implementationStatus)).length;
  const projectStalled = projectOutcomes.filter((row) => isStalled(row.implementationStatus)).length;
  const projectCompletionRate = Math.round((projectCompleted / Math.max(projectOutcomes.length, 1)) * 100);
  const projectStalledRate = Math.round((projectStalled / Math.max(projectOutcomes.length, 1)) * 100);

  const observedRows = projectOutcomes.filter((row) => row.observedImprovement !== null);
  const avgObservedImprovement =
    observedRows.length > 0
      ? Math.round(
          (observedRows.reduce((sum, row) => sum + Number(row.observedImprovement ?? 0), 0) / observedRows.length) * 10
        ) / 10
      : null;

  const pairedRows = projectOutcomes.filter(
    (row) => row.observedImprovement !== null && row.predictedImprovement !== null
  );
  const avgPulseVsPredicted =
    pairedRows.length > 0
      ? Math.round(
          (pairedRows.reduce(
            (sum, row) => sum + Number((row.observedImprovement ?? 0) - (row.predictedImprovement ?? 0)),
            0
          ) /
            pairedRows.length) *
            10
        ) / 10
      : null;

  const adaptationHint =
    projectStalledRate >= 40
      ? "Focus next roadmap cycle on fewer, high-confidence initiatives with explicit unblocking owners."
      : projectCompletionRate >= 65
        ? "Increase weighting for similar initiative types in the next roadmap cycle."
        : "Keep initiative scope stable and collect two more outcomes before changing weighting.";

  const provenanceGaps: string[] = [];
  if (projectOutcomes.length < 3) {
    provenanceGaps.push("Project-level roadmap outcome history is still sparse (<3 records).");
  }
  if (pairedRows.length === 0) {
    provenanceGaps.push("No predicted-vs-observed pairs available yet for calibration.");
  }

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "roadmap-outcome-capture",
        userId: user.id,
        status: "success",
        input: input as unknown as Prisma.InputJsonValue,
        output: {
          recordId: record.id,
          projectId: project.id,
          implementationStatus: record.implementationStatus,
          completionRate: projectCompletionRate,
          stalledRate: projectStalledRate,
          averageObservedImprovement: avgObservedImprovement,
          averagePulseVsPredicted: avgPulseVsPredicted
        } as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });
    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Roadmap outcome audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      recordedOutcome: {
        id: record.id,
        projectId: project.id,
        projectName: project.name,
        recommendationTitle: record.recommendationTitle,
        implementationStatus: record.implementationStatus,
        predictedImprovement: record.predictedImprovement,
        observedImprovement: record.observedImprovement,
        learningScore: record.learningScore,
        createdAt: record.createdAt
      },
      learningSummary: {
        projectSampleSize: projectOutcomes.length,
        userSampleSize: userOutcomes.length,
        completionRate: projectCompletionRate,
        stalledRate: projectStalledRate,
        averageObservedImprovement: avgObservedImprovement,
        averagePulseVsPredicted: avgPulseVsPredicted
      },
      adaptationHint,
      provenance: {
        method: "deterministic-roadmap-outcome-learning-v1",
        source: provenanceGaps.length === 0 ? "live" : "mixed",
        retrievedAt: new Date().toISOString(),
        confidence: clamp(48 + projectOutcomes.length * 7 + pairedRows.length * 5, 45, 93),
        gaps: provenanceGaps
      } satisfies IntelligenceProvenance,
      audit
    },
    "Roadmap outcome captured."
  );
});

export const getRoadmapOutcomeHistoryHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const query = req.query as {
    projectId?: string;
    limit?: number;
    windowDays?: number;
  };
  const projectId = (query.projectId ?? "").trim();
  const limit = query.limit ?? 10;
  const windowDays = query.windowDays ?? 90;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  if (projectId.length > 0) {
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: user.id
      },
      select: { id: true }
    });

    if (!project) {
      throw new NotFoundError("Project not found.");
    }
  }

  const rows = await prisma.implementationOutcomeRecord.findMany({
    where: {
      ...(projectId.length > 0 ? { projectId } : {}),
      createdAt: { gte: windowStart },
      project: {
        userId: user.id
      }
    },
    select: {
      id: true,
      projectId: true,
      recommendationTitle: true,
      implementationStatus: true,
      predictedImprovement: true,
      observedImprovement: true,
      learningScore: true,
      rawData: true,
      createdAt: true,
      project: {
        select: {
          name: true
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  const trendRows = await prisma.implementationOutcomeRecord.findMany({
    where: {
      ...(projectId.length > 0 ? { projectId } : {}),
      createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      project: {
        userId: user.id
      }
    },
    select: {
      implementationStatus: true,
      observedImprovement: true,
      predictedImprovement: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" },
    take: 250
  });

  const completedCount = rows.filter((item) => /completed|done|shipped/i.test(item.implementationStatus)).length;
  const stalledCount = rows.filter((item) => /blocked|stalled|delayed|deferred|cancelled/i.test(item.implementationStatus)).length;

  const withObserved = rows.filter((item) => item.observedImprovement !== null);
  const averageObservedImprovement =
    withObserved.length > 0
      ? Math.round(
          (withObserved.reduce((sum, item) => sum + Number(item.observedImprovement ?? 0), 0) / withObserved.length) * 10
        ) / 10
      : null;

  const generatedAt = new Date().toISOString();
  const gaps: string[] = [];
  if (rows.length === 0) {
    gaps.push(`No roadmap outcomes recorded in the last ${windowDays} days.`);
  }
  if (rows.length > 0 && rows.length < 3) {
    gaps.push("History sample is below 3 outcomes; trend confidence is limited.");
  }

  const summarizeTrendWindow = (days: 30 | 60 | 90) => {
    const windowFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scoped = trendRows.filter((item) => item.createdAt >= windowFrom);
    const completed = scoped.filter((item) => /completed|done|shipped/i.test(item.implementationStatus)).length;
    const stalled = scoped.filter((item) => /blocked|stalled|delayed|deferred|cancelled/i.test(item.implementationStatus)).length;

    const observedOnly = scoped.filter((item) => item.observedImprovement !== null);
    const avgObservedImprovement =
      observedOnly.length > 0
        ? Math.round(
            (observedOnly.reduce((sum, item) => sum + Number(item.observedImprovement ?? 0), 0) / observedOnly.length) * 10
          ) / 10
        : null;

    const paired = scoped.filter((item) => item.observedImprovement !== null && item.predictedImprovement !== null);
    const avgPulseVsPredicted =
      paired.length > 0
        ? Math.round(
            (paired.reduce(
              (sum, item) => sum + Number((item.observedImprovement ?? 0) - (item.predictedImprovement ?? 0)),
              0
            ) /
              paired.length) *
              10
          ) / 10
        : null;

    return {
      totalOutcomes: scoped.length,
      completedCount: completed,
      stalledCount: stalled,
      completionRate: scoped.length > 0 ? Math.round((completed / scoped.length) * 100) : 0,
      averageObservedImprovement: avgObservedImprovement,
      averagePulseVsPredicted: avgPulseVsPredicted
    };
  };

  const trendWindows = {
    days30: summarizeTrendWindow(30),
    days60: summarizeTrendWindow(60),
    days90: summarizeTrendWindow(90)
  };

  sendSuccess(
    res,
    {
      history: rows.map((item) => ({
        id: item.id,
        projectId: item.projectId,
        projectName: item.project.name,
        recommendationTitle: item.recommendationTitle,
        implementationStatus: item.implementationStatus,
        predictedImprovement: item.predictedImprovement,
        observedImprovement: item.observedImprovement,
        learningScore: item.learningScore,
        note:
          item.rawData && typeof item.rawData === "object" && !Array.isArray(item.rawData)
            ? String((item.rawData as Record<string, unknown>).note ?? "") || null
            : null,
        createdAt: item.createdAt
      })),
      summary: {
        totalOutcomes: rows.length,
        completedCount,
        stalledCount,
        averageObservedImprovement,
        windowDays
      },
      trendWindows,
      provenance: {
        method: "deterministic-roadmap-outcome-history-v1",
        source: rows.length === 0 ? "fallback" : gaps.length > 0 ? "mixed" : "live",
        retrievedAt: generatedAt,
        confidence: clamp(48 + rows.length * 6 + completedCount * 3, 45, 92),
        gaps
      } satisfies IntelligenceProvenance
    },
    "Roadmap outcome history fetched."
  );
});

export const generateDemandForecastHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = (req.body ?? {}) as DemandForecastInput;
  const horizonWeeks = clamp(Math.round(input.horizonWeeks ?? 12), 4, 26);
  const since30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [opportunityLogs, clientLogs, adaptiveSummary, projects, recentReports] = await Promise.all([
    prisma.agentLog.count({
      where: {
        userId: user.id,
        agentName: "opportunity-assessment",
        createdAt: { gte: since30Days }
      }
    }),
    prisma.agentLog.count({
      where: {
        userId: user.id,
        agentName: "client-acquisition-assessment",
        createdAt: { gte: since30Days }
      }
    }),
    summarizeAdaptiveScoring(user.id),
    prisma.project.count({ where: { userId: user.id } }),
    prisma.intelligenceReport.findMany({
      where: {
        status: "completed",
        snapshot: {
          project: {
            userId: user.id
          }
        }
      },
      select: { overallScore: true },
      orderBy: { createdAt: "desc" },
      take: 20
    })
  ]);

  const averageProjectScore =
    recentReports.length === 0
      ? 52
      : Math.round(
          recentReports.reduce((sum, report) => sum + (report.overallScore ?? 0), 0) / Math.max(recentReports.length, 1)
        );

  const demandIndex = clamp(
    Math.round(
      opportunityLogs * 2.2 +
        clientLogs * 2.6 +
        adaptiveSummary.winRate * 0.35 +
        averageProjectScore * 0.25 +
        Math.min(projects, 8) * 1.6
    ),
    5,
    96
  );

  const outlook: DemandForecastResult["outlook"] = demandIndex >= 72 ? "EXPAND" : demandIndex >= 52 ? "HOLD" : "DEFEND";
  const horizonFactor = horizonWeeks / 12;
  const baseQualifiedPipeline = Math.max(1, Math.round((clientLogs * 1.3 + opportunityLogs * 0.8 + projects * 0.6) * horizonFactor));

  const gaps: string[] = [];
  if (adaptiveSummary.sampleSize < 5) {
    gaps.push("Outcome sample size is below 5; forecast confidence is limited.");
  }
  if (recentReports.length < 3) {
    gaps.push("Limited completed project reports in the recent window.");
  }

  const generatedAt = new Date().toISOString();
  const forecast: DemandForecastResult = {
    horizonWeeks,
    generatedAt,
    kpis: {
      recentOpportunityAssessments: opportunityLogs,
      recentClientAssessments: clientLogs,
      adaptiveWinRate: adaptiveSummary.winRate,
      activeProjects: projects,
      averageProjectScore
    },
    demandIndex,
    outlook,
    forecastBands: {
      conservativeQualifiedPipeline: Math.max(1, Math.round(baseQualifiedPipeline * 0.75)),
      baseQualifiedPipeline,
      aggressiveQualifiedPipeline: Math.max(1, Math.round(baseQualifiedPipeline * 1.35))
    },
    recommendedActions: [
      outlook === "EXPAND"
        ? "Increase outbound volume by 20% and prioritize TAKE_NOW accounts."
        : "Focus on conversion quality before scaling outbound activity.",
      averageProjectScore < 65
        ? "Stabilize delivery quality to protect forecasted demand confidence."
        : "Package top delivery wins into pitch collateral for higher close rates.",
      "Review forecast weekly and compare projected vs actual qualified pipeline."
    ],
    provenance: {
      method: "deterministic-demand-forecast-v1",
      source: gaps.length > 0 ? "mixed" : "live",
      retrievedAt: generatedAt,
      confidence: clamp(58 + Math.min(opportunityLogs + clientLogs, 15) + Math.round(adaptiveSummary.winRate * 0.12), 45, 93),
      gaps
    }
  };

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "demand-forecast-quarterly",
        userId: user.id,
        status: "success",
        input: (input as unknown as Prisma.InputJsonValue) ?? ({} as Prisma.InputJsonValue),
        output: forecast as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });
    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Demand forecast audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      forecast,
      audit
    },
    "Demand forecast generated."
  );
});

export const generateMarketingGuidanceHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = (req.body ?? {}) as MarketingGuidanceInput;
  const campaignHorizonWeeks = clamp(Math.round(input.campaignHorizonWeeks ?? 4), 2, 12);
  const focusGoal = input.focusGoal ?? "PIPELINE";
  const since30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [clientAssessments, adaptiveSummary, recentProjectReports] = await Promise.all([
    prisma.agentLog.count({
      where: {
        userId: user.id,
        agentName: "client-acquisition-assessment",
        createdAt: { gte: since30Days }
      }
    }),
    summarizeAdaptiveScoring(user.id),
    prisma.intelligenceReport.findMany({
      where: {
        status: "completed",
        snapshot: { project: { userId: user.id } }
      },
      select: { overallScore: true },
      orderBy: { createdAt: "desc" },
      take: 10
    })
  ]);

  const averageProjectScore =
    recentProjectReports.length === 0
      ? 55
      : Math.round(
          recentProjectReports.reduce((sum, report) => sum + (report.overallScore ?? 0), 0) /
            Math.max(recentProjectReports.length, 1)
        );

  const pipelineStrength = clamp(Math.round(clientAssessments * 6 + adaptiveSummary.winRate * 0.45 + averageProjectScore * 0.2), 0, 100);
  const conversionPressure = clamp(100 - adaptiveSummary.winRate + (averageProjectScore < 60 ? 12 : 0), 0, 100);

  const channelPriorities: MarketingGuidanceResult["channelPriorities"] = [
    {
      channel: "Email",
      priority: pipelineStrength < 55 ? "HIGH" : "MEDIUM",
      rationale: "Email sequences provide controllable outreach volume for weekly pipeline generation."
    },
    {
      channel: "LinkedIn",
      priority: focusGoal === "PIPELINE" ? "HIGH" : "MEDIUM",
      rationale: "LinkedIn distribution improves founder-led reach for B2B decision-makers."
    },
    {
      channel: "Webinar",
      priority: conversionPressure > 45 ? "HIGH" : "LOW",
      rationale: "Live sessions reduce objection friction and improve conversion confidence."
    },
    {
      channel: "CaseStudy",
      priority: averageProjectScore >= 65 ? "HIGH" : "MEDIUM",
      rationale: "Outcome evidence strengthens credibility in competitive deal cycles."
    }
  ];

  const contentRecommendations: MarketingGuidanceResult["contentRecommendations"] = [
    {
      title: "How we improved conversion outcomes in 30 days",
      format: "case-study",
      objective: "Build trust with quantified delivery proof."
    },
    {
      title: "3 fast wins to stabilize your project intelligence score",
      format: "post",
      objective: "Create top-of-funnel awareness with problem-first messaging."
    },
    {
      title: "4-touch outbound sequence for TAKE_NOW accounts",
      format: "email-sequence",
      objective: "Improve pipeline velocity with structured follow-up cadence."
    }
  ];

  const guidanceGaps: string[] = [];
  if (adaptiveSummary.sampleSize < 5) {
    guidanceGaps.push("Outcome sample size is low; channel mix confidence is limited.");
  }
  if (clientAssessments < 2) {
    guidanceGaps.push("Low recent client assessment volume may bias outreach recommendations.");
  }

  const generatedAt = new Date().toISOString();
  const guidance: MarketingGuidanceResult = {
    campaignHorizonWeeks,
    generatedAt,
    focusGoal,
    channelPriorities,
    contentRecommendations,
    outreachGuidance: {
      cadencePerWeek: pipelineStrength >= 65 ? 12 : 8,
      targetAccountMix: {
        takeNowPercent: adaptiveSummary.winRate >= 60 ? 65 : 50,
        nurturePercent: adaptiveSummary.winRate >= 60 ? 35 : 50
      }
    },
    provenance: {
      method: "deterministic-marketing-guidance-v1",
      source: guidanceGaps.length > 0 ? "mixed" : "live",
      retrievedAt: generatedAt,
      confidence: clamp(56 + Math.min(clientAssessments * 5, 20) + Math.round(adaptiveSummary.winRate * 0.15), 45, 92),
      gaps: guidanceGaps
    }
  };

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "marketing-guidance-weekly",
        userId: user.id,
        status: "success",
        input: (input as unknown as Prisma.InputJsonValue) ?? ({} as Prisma.InputJsonValue),
        output: guidance as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });
    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Marketing guidance audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      guidance,
      audit
    },
    "Marketing guidance generated."
  );
});

export const generateProjectMonitoringDigestHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const input = (req.body ?? {}) as ProjectMonitoringInput;
  const maxProjects = clamp(Math.round(input.maxProjects ?? 8), 1, 20);
  const minScoreThreshold = clamp(Math.round(input.minScoreThreshold ?? 62), 35, 85);

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    select: { id: true, name: true },
    orderBy: { updatedAt: "desc" },
    take: maxProjects
  });

  const healthByProject = await Promise.all(projects.map((project) => buildProjectHealthInsights(project.id, user.id)));

  const projectRows: ProjectMonitoringResult["projects"] = healthByProject.map((health, index) => {
    const latestScore = health.latestScore;
    const alertLevel: "CRITICAL" | "WARNING" | "HEALTHY" =
      latestScore === null || latestScore < minScoreThreshold - 8
        ? "CRITICAL"
        : latestScore < minScoreThreshold || health.riskSignals.length > 0
          ? "WARNING"
          : "HEALTHY";

    return {
      projectId: health.projectId,
      projectName: projects[index]?.name ?? "Unnamed project",
      latestScore,
      trendPulse: health.trendPulse,
      alertLevel,
      riskSignals: health.riskSignals,
      topFeatureUpdates: health.featureUpdateRecommendations.slice(0, 3),
      provenance: health.provenance
    };
  });

  const alerts = {
    critical: projectRows.filter((item) => item.alertLevel === "CRITICAL").length,
    warning: projectRows.filter((item) => item.alertLevel === "WARNING").length,
    healthy: projectRows.filter((item) => item.alertLevel === "HEALTHY").length
  };

  const aggregatedRecommendations = Array.from(
    new Set(
      projectRows
        .flatMap((item) => item.topFeatureUpdates.map((update) => update.recommendation))
        .filter((item) => item.trim().length > 0)
    )
  ).slice(0, 6);

  const digestGaps: string[] = [];
  if (projectRows.length === 0) {
    digestGaps.push("No active projects found for this user; monitoring digest is fallback-only.");
  }
  if (projectRows.some((item) => item.latestScore === null)) {
    digestGaps.push("Some projects are missing completed reports; alert confidence is reduced.");
  }

  const generatedAt = new Date().toISOString();
  const digest: ProjectMonitoringResult = {
    generatedAt,
    projectCount: projectRows.length,
    minScoreThreshold,
    alerts,
    projects: projectRows,
    aggregatedRecommendations,
    provenance: {
      method: "deterministic-project-monitoring-v1",
      source: projectRows.length > 0 ? (digestGaps.length > 0 ? "mixed" : "live") : "fallback",
      retrievedAt: generatedAt,
      confidence: clamp(58 + projectRows.length * 4 - alerts.critical * 3, 45, 92),
      gaps: digestGaps
    }
  };

  let audit: { logId: string | null; createdAt: Date | null; persisted: boolean } = {
    logId: null,
    createdAt: null,
    persisted: false
  };

  try {
    const log = await prisma.agentLog.create({
      data: {
        agentName: "project-monitoring-digest-daily",
        userId: user.id,
        status: "success",
        input: (input as unknown as Prisma.InputJsonValue) ?? ({} as Prisma.InputJsonValue),
        output: digest as unknown as Prisma.InputJsonValue,
        executionTimeMs: 1,
        tokenUsage: 0
      }
    });

    audit = {
      logId: log.id,
      createdAt: log.createdAt,
      persisted: true
    };
  } catch (error) {
    logger.warn({ error, userId: user.id }, "Project monitoring digest audit log persistence failed.");
  }

  sendSuccess(
    res,
    {
      digest,
      audit
    },
    "Project monitoring digest generated."
  );
});

export const getGlobalHealthSummaryHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    select: { id: true, name: true }
  });

  const projectIds = projects.map((p) => p.id);
  const latestReports = await Promise.all(
    projectIds.map((projectId) =>
      prisma.intelligenceReport.findFirst({
        where: { snapshot: { projectId }, status: "completed" },
        orderBy: { createdAt: "desc" },
        select: { overallScore: true }
      })
    )
  );

  const scores = latestReports.map((r) => r?.overallScore).filter((s): s is number => s !== null && s !== undefined);
  const averageScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 68;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const previousReports = await Promise.all(
    projectIds.map((projectId) =>
      prisma.intelligenceReport.findFirst({
        where: { snapshot: { projectId }, status: "completed", createdAt: { lt: yesterday } },
        orderBy: { createdAt: "desc" },
        select: { overallScore: true }
      })
    )
  );

  const prevScores = previousReports.map((r) => r?.overallScore).filter((s): s is number => s !== null && s !== undefined);
  const prevAverage = prevScores.length > 0 ? Math.round(prevScores.reduce((a, b) => a + b, 0) / prevScores.length) : averageScore;
  const trendPulse = averageScore - prevAverage;

  const momentum: "STRONG" | "STEADY" | "AT_RISK" = averageScore >= 75 ? "STRONG" : averageScore >= 60 ? "STEADY" : "AT_RISK";

  sendSuccess(res, { averageScore, trendPulse, momentum, projectCount: projects.length }, "Global health summary fetched.");
});

export const runHelenaPrecisionAnalysisHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const lookbackDays = typeof body.lookbackDays === "number" ? body.lookbackDays : undefined;
  const maxSamples = typeof body.maxSamples === "number" ? body.maxSamples : undefined;

  const analysis = await runHelenaPrecisionAnalysis({
    userId: user.id,
    lookbackDays,
    maxSamples
  });

  sendSuccess(
    res,
    {
      telemetry: analysis.telemetry,
      precision: analysis.result
    },
    "Helena precision analysis completed from live company telemetry."
  );
});

export const getHelenaPrecisionBoardHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const board = await getHelenaPrecisionBoard(user.id);

  sendSuccess(
    res,
    board,
    "Helena precision board loaded for command center."
  );
});

export const getIntelligenceDecisionHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  
  const currentScore = record.report.overallScore;
  let trendPulse: number | null = null;
  if (currentScore !== null) {
    const prev = await prisma.intelligenceReport.findFirst({
      where: { snapshot: { projectId: record.report.snapshot.projectId }, status: "completed", id: { not: record.report.id } },
      orderBy: { createdAt: "desc" },
      select: { overallScore: true }
    });
    const previousScore = prev?.overallScore;
    if (previousScore !== null && previousScore !== undefined) trendPulse = currentScore - previousScore;
  }

  const payload = parseDecisionFromReport(record.report, trendPulse);
  sendSuccess(res, payload, "Decision payload fetched.");
});

export const getExecutionBlueprintHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);

  const blueprint = {
    snapshotId,
    generatedAt: record.report.createdAt,
    overallScore: record.report.overallScore,
    actions: record.report.priorityActions.map(asPriorityAction),
    outcomes: record.report.implementationOutcomes
  };
  sendSuccess(res, blueprint, "Execution blueprint fetched.");
});

export const getIntelligenceExportHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, serializeIntelligenceReport(record.report), "Export payload fetched.");
});

export const getIntelligenceExportPreviewHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, { preview: true, snapshotId }, "Export preview generated.");
});

export const getIntelligenceReportHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, serializeIntelligenceReport(record.report), "Intelligence report fetched.");
});

export const getIntelligenceScoreHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, { snapshotId, overallScore: record.report.overallScore }, "Intelligence score fetched.");
});

export const getPriorityRoadmapHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, { initiatives: record.report.priorityActions.map(asPriorityAction) }, "Priority roadmap fetched.");
});

export const getStrategicPositionHandler = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const snapshotId = String(req.params.snapshotId);
  const user = requireUser(req);
  const record = await getIntelligenceRecord(snapshotId, user.id, user.role);
  sendSuccess(res, { position: record.report.marketPosition, signals: record.report.competitorSignals }, "Strategic position fetched.");
});
