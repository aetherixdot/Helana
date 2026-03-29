import { Router } from "express";
import { authenticateGatewayOrUser } from "../middleware/auth.middleware";
import { requireGatewayAuth } from "../middleware/gateway-auth.middleware";
import { validateBody, validateQuery } from "../middleware/validate.middleware";
import {
  assessClientAcquisitionHandler,
  assessOpportunityHandler,
  streamIdeaAnalysisHandler,
  captureRoadmapOutcomeHandler,
  captureClientOutcomeHandler,
  generateDemandForecastHandler,
  generateMarketingGuidanceHandler,
  generateProductRoadmapHandler,
  generateProjectMonitoringDigestHandler,
  getGlobalHealthSummaryHandler,
  getOpportunityHistoryHandler,
  getIntelligenceDecisionHandler,
  getExecutionBlueprintHandler,
  getDailyBriefingHandler,
  getIntelligenceInsightsHandler,
  setIntelligenceInsightReadStateHandler,
  getIntelligenceExportHandler,
  getIntelligenceExportPreviewHandler,
  getIntelligenceReportHandler,
  getIntelligenceScoreHandler,
  getRoadmapOutcomeHistoryHandler,
  getPriorityRoadmapHandler,
  getProjectHealthSignalsHandler,
  getStrategicPositionHandler,
  getWeeklyOperatingReviewHandler,
  streamIntelligenceChatHandler,
  analyzeWebsiteHandler,
  runHelenaPrecisionAnalysisHandler,
  getHelenaPrecisionBoardHandler
} from "../controllers/intelligence.controller";
import {
  clientAcquisitionAssessmentSchema,
  clientOutcomeCaptureSchema,
  insightReadStateSchema,
  intelligenceChatStreamSchema,
  opportunityHistoryQuerySchema,
  roadmapOutcomeCaptureSchema,
  roadmapOutcomeHistoryQuerySchema,
  opportunityAssessmentSchema
} from "../validators/intelligence.validator";

const router = Router();

router.use(requireGatewayAuth);
router.use(authenticateGatewayOrUser);

// Global Intelligence
router.post("/analyze", analyzeWebsiteHandler);

// Opportunity loop routes
router.post("/opportunity/assess", validateBody(opportunityAssessmentSchema), assessOpportunityHandler);
router.post("/idea/stream", validateBody(opportunityAssessmentSchema), streamIdeaAnalysisHandler);
router.get("/opportunity/history", validateQuery(opportunityHistoryQuerySchema), getOpportunityHistoryHandler);
router.post("/client/assess", validateBody(clientAcquisitionAssessmentSchema), assessClientAcquisitionHandler);
router.post("/client/outcome", validateBody(clientOutcomeCaptureSchema), captureClientOutcomeHandler);

// Operating loop routes
router.get("/health/summary", getGlobalHealthSummaryHandler);
router.get("/project/:projectId/health", getProjectHealthSignalsHandler);
router.get("/review/weekly", getWeeklyOperatingReviewHandler);
router.post("/roadmap/recommendations", generateProductRoadmapHandler);
router.post("/roadmap/outcome", validateBody(roadmapOutcomeCaptureSchema), captureRoadmapOutcomeHandler);
router.get("/roadmap/outcomes/history", validateQuery(roadmapOutcomeHistoryQuerySchema), getRoadmapOutcomeHistoryHandler);
router.post("/demand/forecast", generateDemandForecastHandler);
router.post("/projects/monitor", generateProjectMonitoringDigestHandler);
router.post("/marketing/guidance", generateMarketingGuidanceHandler);
router.get("/briefing/daily", getDailyBriefingHandler);
router.get("/insights", getIntelligenceInsightsHandler);
router.post("/insights/:insightId/read", validateBody(insightReadStateSchema), setIntelligenceInsightReadStateHandler);
router.post("/chat/stream", validateBody(intelligenceChatStreamSchema), streamIntelligenceChatHandler);
router.post("/helena/precision/analyze", runHelenaPrecisionAnalysisHandler);
router.get("/helena/precision/board", getHelenaPrecisionBoardHandler);

// Intelligence Report Routes
router.get("/:snapshotId/export", getIntelligenceExportHandler);
router.get("/:snapshotId/export/preview", getIntelligenceExportPreviewHandler);
router.get("/:snapshotId", getIntelligenceReportHandler);
router.get("/:snapshotId/score", getIntelligenceScoreHandler);
router.get("/:snapshotId/decision", getIntelligenceDecisionHandler);
router.get("/:snapshotId/roadmap", getPriorityRoadmapHandler);
router.get("/:snapshotId/strategy", getStrategicPositionHandler);
router.get("/:snapshotId/blueprint", getExecutionBlueprintHandler);

export default router;
