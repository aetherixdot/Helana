/**
 * Daily Briefing Background Job
 * Runs daily to generate executive intelligence briefing
 */

import { Job } from "bull";
import { logger } from "../config/logger";
import {
  generateDailyBriefing,
  persistBriefing,
  type DailyBriefing
} from "../services/daily-briefing.service";
import { runHelenaPrecisionAnalysis } from "../services/helena-precision.service";

export const processDailyBriefingJob = async (job: Job<Record<string, unknown>>): Promise<void> => {
  logger.info(`[DAILY_BRIEFING_JOB] Starting daily briefing generation (Job ID: ${job.id})`);

  try {
    // Update progress
    await job.progress(10);

    // Generate briefing with real company data
    logger.info('[DAILY_BRIEFING_JOB] Generating briefing from company data...');
    const briefing = await generateDailyBriefing();
    
    await job.progress(50);
    logger.debug(`[DAILY_BRIEFING_JOB] Generated ${briefing.sections.length} sections with ${briefing.confidence}% confidence`);

    // Persist for audit trail
    logger.info('[DAILY_BRIEFING_JOB] Persisting briefing to audit log...');
    await persistBriefing(briefing);

    logger.info('[DAILY_BRIEFING_JOB] Running Helena precision analysis on fresh telemetry...');
    await runHelenaPrecisionAnalysis({ lookbackDays: 14, maxSamples: 700 });
    
    await job.progress(100);
    logger.info(`[DAILY_BRIEFING_JOB] Completed successfully. Sections: ${briefing.sections.length}, Time: ${briefing.generateTime}ms, Momentum: ${briefing.companyMomentum.score}`);
  } catch (error) {
    logger.error({ error }, '[DAILY_BRIEFING_JOB]  Error');
    throw error;
  }
};

/**
 * Get last briefing for dashboard display
 */
export async function getLastBriefing(): Promise<DailyBriefing | null> {
  try {
    const { prisma } = await import("../config/prisma");
    const log = await prisma.agentLog.findFirst({
      where: { agentName: 'DAILY_BRIEFING_GENERATOR' },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!log) return null;
    
    return JSON.parse(typeof log.output === 'string' ? log.output : JSON.stringify(log.output || {}));
  } catch (error) {
    logger.error({ error }, 'Error retrieving last briefing');
    return null;
  }
}
