"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { 
  Zap, 
  Activity, 
  TrendingUp, 
  AlertCircle, 
  Clock, 
  Users, 
  Briefcase, 
  BarChart3,
  Brain,
  ArrowRight,
  ShieldCheck,
  Plus,
  Send
} from "lucide-react";
import {
  getAiInsights,
  getCompanySettings,
  getDailyBriefing,
   getHelenaPrecisionBoard,
  getPipelineAnalytics,
  getRevenueAnalytics,
  listProjects,
  listReminders,
   type HelenaPrecisionBoard,
  type InsightItem,
  type ProjectSummary,
  type ReminderSummary,
} from "@/lib/api";
import { TacticalHUD, HUDItem } from "@/components/ui/tactical-hud";

export default function CommandCenterPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<{ headline: string; signals: string[] } | null>(null);
  const [revenue, setRevenue] = useState<{ current: number; planned: number } | null>(null);
  const [pipeline, setPipeline] = useState<{ leads: number; qualified: number; active: number } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [reminders, setReminders] = useState<ReminderSummary[]>([]);
   const [precisionBoard, setPrecisionBoard] = useState<HelenaPrecisionBoard | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
            const [briefingData, revenueData, pipelineData, projectData, insightData, reminderData, precisionBoardData] = await Promise.all([
          getDailyBriefing(),
          getRevenueAnalytics(),
          getPipelineAnalytics(),
          listProjects(),
          getAiInsights(),
          listReminders(),
               getHelenaPrecisionBoard().catch(() => null),
        ]);

        if (cancelled) return;

        setBriefing({
          headline: briefingData?.overview?.headline ?? "No active briefing signals.",
          signals: Array.isArray(briefingData?.topSignals) ? briefingData.topSignals : [],
        });
        setRevenue({ current: revenueData.monthToDateRevenue, planned: revenueData.plannedRevenue });
        setPipeline({ leads: pipelineData.leads, qualified: pipelineData.qualified, active: pipelineData.active });
        setProjects((projectData as any).projects?.slice(0, 5) || []);
        setInsights((insightData as any).insights?.slice(0, 4) || []);
        setReminders((reminderData as any).reminders?.slice(0, 5) || []);
            if (precisionBoardData) {
               setPrecisionBoard(precisionBoardData);
            }
        setLastUpdated(new Date().toISOString());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Command center offline.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col space-y-6 reveal">
      {/* Header HUD */}
      <TacticalHUD>
        <HUDItem label="MTD Alpha" value={`$${revenue?.current || 0}`} status="success" />
        <HUDItem label="Pipeline Signal" value={pipeline?.active || 0} status="warning" />
        <HUDItem label="Strategic Pulse" value="NOMINAL" status="success" />
        <HUDItem label="Network Latency" value="24MS" status="info" />
      </TacticalHUD>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main Intelligence Grid */}
        <div className="space-y-6">
               <section className="bg-[#0d1324] border border-[#1a1f2f] p-4">
                  <div className="flex items-center justify-between mb-4">
                     <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#3cd7ff]">Helena Precision Board</h3>
                     <span className="text-[9px] font-mono text-ink-500">{precisionBoard?.generatedAt ? new Date(precisionBoard.generatedAt).toLocaleString() : "awaiting-data"}</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                     <div className="bg-[#161b2a] border border-[#2f3445] p-3">
                        <p className="text-[9px] uppercase tracking-widest text-ink-500">Low-Confidence Trend</p>
                        <p className="text-xl font-bold text-[#dee1f7] mt-1">{precisionBoard?.confidenceTrend.at(-1)?.value ?? 0}%</p>
                        <p className="text-[10px] text-ink-500 mt-2">
                           {precisionBoard?.confidenceTrend.length ? `${precisionBoard.confidenceTrend.length} checkpoints / 14d` : "No checkpoints yet"}
                        </p>
                     </div>
                     <div className="bg-[#161b2a] border border-[#2f3445] p-3">
                        <p className="text-[9px] uppercase tracking-widest text-ink-500">Fail Cluster Trend</p>
                        <p className="text-xl font-bold text-[#feb700] mt-1">{precisionBoard?.failureTrend.at(-1)?.value ?? 0}</p>
                        <p className="text-[10px] text-ink-500 mt-2">
                           latest daily failed executions
                        </p>
                     </div>
                     <div className="bg-[#161b2a] border border-[#2f3445] p-3">
                        <p className="text-[9px] uppercase tracking-widest text-ink-500">Rollout Gate</p>
                        <p className={`text-xl font-bold mt-1 ${precisionBoard?.rolloutGate?.canPromote ? "text-[#20c7a3]" : "text-[#ff6b7c]"}`}>
                           {precisionBoard?.rolloutGate?.canPromote ? "PASS" : "BLOCK"}
                        </p>
                        <p className="text-[10px] text-ink-500 mt-2">
                           conf {precisionBoard?.rolloutGate?.current.confidenceScore ?? 0} / rel {precisionBoard?.rolloutGate?.current.relevanceScore ?? 0}
                        </p>
                     </div>
                  </div>
                  <div className="mt-3 bg-[#11172a] border border-[#2b3142] p-3">
                     <p className="text-[9px] uppercase tracking-widest text-ink-500 mb-2">Recommended Training Targets</p>
                     <p className="text-xs text-ink-300">
                        SFT target: {precisionBoard?.recommendedTargets.sftExamplesTarget ?? 0} | DPO target: {precisionBoard?.recommendedTargets.dpoPairsTarget ?? 0}
                     </p>
                     <div className="mt-2 space-y-1">
                        {(precisionBoard?.recommendedTargets.datasetActions || []).slice(0, 2).map((action, idx) => (
                           <p key={`${idx}-${action}`} className="text-[10px] text-ink-500">- {action}</p>
                        ))}
                     </div>
                  </div>
               </section>

          {/* AI Briefing Banner */}
          <section className="bg-[#1a1f2f]/30 border border-[#3cd7ff]/20 p-6 flex items-start gap-4">
             <Brain size={24} className="text-[#3cd7ff] shrink-0" />
             <div>
                <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#3cd7ff] mb-2">Neural Intelligence Briefing</h3>
                <p className="text-lg font-bold text-white leading-tight mb-2">
                   {loading ? "Decrypting mission parameters..." : briefing?.headline}
                </p>
                <div className="flex flex-wrap gap-2 mt-4">
                   {(briefing?.signals || []).map((s, i) => (
                      <span key={i} className="text-[10px] font-mono bg-[#161b2a] border border-[#1a1f2f] px-2 py-1 text-ink-300">
                         {s}
                      </span>
                   ))}
                </div>
             </div>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Active Deployments */}
            <section className="bg-[#090e1c] border border-[#1a1f2f] flex flex-col">
               <div className="p-4 border-b border-[#1a1f2f] flex justify-between items-center bg-[#1a1f2f]/20">
                  <div className="flex items-center gap-2">
                     <Activity size={16} className="text-[#3cd7ff]" />
                     <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#dee1f7]">Active Deployments</h3>
                  </div>
                  <Link href="/projects" className="text-[10px] uppercase font-bold text-ink-500 hover:text-white transition">Full Registry</Link>
               </div>
               <div className="p-4 space-y-3">
                  {projects.map(p => (
                    <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center justify-between p-3 bg-[#161b2a] border border-transparent hover:border-[#3cd7ff]/20 transition">
                       <span className="text-xs font-bold text-[#dee1f7]">{p.name}</span>
                       <span className="text-[9px] font-mono text-[#3cd7ff]">ON-TRACK</span>
                    </Link>
                  ))}
                  {projects.length === 0 && !loading && <p className="text-xs text-ink-500 p-4 text-center font-mono italic">No active nodes detected.</p>}
               </div>
            </section>

            {/* Tactical Reminders */}
            <section className="bg-[#090e1c] border border-[#1a1f2f] flex flex-col">
               <div className="p-4 border-b border-[#1a1f2f] flex justify-between items-center bg-[#1a1f2f]/20">
                  <div className="flex items-center gap-2">
                     <Clock size={16} className="text-[#feb700]" />
                     <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#dee1f7]">Critical Reminders</h3>
                  </div>
                  <Link href="/reminders" className="text-[10px] uppercase font-bold text-ink-500 hover:text-white transition">View All</Link>
               </div>
               <div className="p-4 space-y-4">
                  {reminders.map(r => (
                    <div key={r.id} className="flex gap-4 items-start pl-2 border-l-2 border-[#feb700]">
                       <div>
                          <p className="text-xs font-bold text-[#dee1f7]">{r.title}</p>
                          <p className="text-[10px] text-ink-500 font-mono mt-0.5">{new Date(r.dueAt).toLocaleDateString()} {new Date(r.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                       </div>
                    </div>
                  ))}
                  {reminders.length === 0 && !loading && <p className="text-xs text-ink-500 p-4 text-center font-mono italic">Sector clear of pending tasks.</p>}
               </div>
            </section>
          </div>
        </div>

        {/* Sidebar Analytics */}
        <aside className="space-y-6">
           {/* Insight Feed */}
           <section className="bg-[#0e1322] border border-[#1a1f2f] p-5">
              <div className="flex items-center gap-2 mb-6">
                 <Zap size={18} className="text-[#3cd7ff]" />
                 <h3 className="text-xs font-bold uppercase tracking-widest text-[#dee1f7]">Intelligence Feed</h3>
              </div>
              <div className="space-y-6">
                 {insights.map(i => {
                    const isRisky = (i.confidenceScore || 0) < 0.7;
                    return (
                       <article key={i.id} className="space-y-2 relative">
                          <div className="flex justify-between items-center bg-[#1a1f2f] px-2 py-0.5 border border-[#2f3445]">
                             <span className="text-[9px] font-bold text-[#3cd7ff] uppercase">{i.category || "STRATEGY"}</span>
                             {isRisky && <span className="text-[9px] font-bold text-[#feb700] uppercase tracking-tighter shrink-0 ml-2">DATA_RISK</span>}
                          </div>
                          <p className="text-xs text-[#bbc9cf] leading-relaxed line-clamp-3">{i.summary}</p>
                       </article>
                    );
                 })}
                 <Link href="/intelligence" className="block w-full py-3 bg-[#1a1f2f] border border-[#2f3445] text-[10px] font-bold uppercase text-center text-ink-300 hover:text-[#3cd7ff] transition">Access Data Lake</Link>
              </div>
           </section>

            {/* Strategic Operation Log */}
            <section className="bg-[#090e1c] border border-[#1a1f2f] p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-ink-300">Strategic Operation Log</h3>
                <span className="text-[9px] font-mono text-[#3cd7ff] animate-pulse">● LIVE_FEED</span>
              </div>
              <div className="space-y-3 font-mono text-[10px]">
                <div className="flex gap-3">
                  <span className="text-ink-500">08:42</span>
                  <p className="text-ink-300"><span className="text-[#3cd7ff]">[SIGNAL]</span> Market Pulse alignment drift detected in SaaS/Fintech sectors.</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-ink-500">08:15</span>
                  <p className="text-ink-300"><span className="text-[#20c7a3]">[CORE]</span> Outcome history for Project Alpha correlated with 92% confidence.</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-ink-500">07:50</span>
                           <p className="text-ink-300"><span className="text-[#feb700]">[WARN]</span> Gate status: {precisionBoard?.rolloutGate?.canPromote ? "promotion unlocked" : "promotion blocked by thresholds"}.</p>
                </div>
                <div className="flex gap-3 text-ink-500 italic">
                  <span>--:--</span>
                           <p>{precisionBoard?.rolloutGate?.reasons?.[0] || "Awaiting next telemetry burst from Marketing Orchestrator..."}</p>
                </div>
              </div>
            </section>

            {/* Quick Action Matrix */}
            <section className="grid grid-cols-2 gap-3">
              <Link href="/marketing" className="flex flex-col items-center justify-center p-4 bg-[#090e1c] border border-[#1a1f2f] hover:border-[#3cd7ff]/40 transition group">
                 <Send size={18} className="text-ink-500 group-hover:text-[#3cd7ff] mb-2" />
                 <span className="text-[9px] font-bold uppercase tracking-widest text-[#dee1f7]">Generate</span>
              </Link>
              <Link href="/clients" className="flex flex-col items-center justify-center p-4 bg-[#090e1c] border border-[#1a1f2f] hover:border-[#3cd7ff]/40 transition group">
                 <Plus size={18} className="text-ink-500 group-hover:text-[#3cd7ff] mb-2" />
                 <span className="text-[9px] font-bold uppercase tracking-widest text-[#dee1f7]">New Client</span>
              </Link>
              <Link href="/products" className="flex flex-col items-center justify-center p-4 bg-[#090e1c] border border-[#1a1f2f] hover:border-[#3cd7ff]/40 transition group">
                 <ShieldCheck size={18} className="text-ink-500 group-hover:text-[#3cd7ff] mb-2" />
                 <span className="text-[9px] font-bold uppercase tracking-widest text-[#dee1f7]">Validate</span>
              </Link>
              <Link href="/intelligence" className="flex flex-col items-center justify-center p-4 bg-[#090e1c] border border-[#1a1f2f] hover:border-[#3cd7ff]/40 transition group">
                 <BarChart3 size={18} className="text-ink-500 group-hover:text-[#3cd7ff] mb-2" />
                 <span className="text-[9px] font-bold uppercase tracking-widest text-[#dee1f7]">Reports</span>
              </Link>
           </section>
        </aside>
      </div>
    </div>
  );
}
