export type IdeaInput = {
  productName?: string;
  description: string;
  targetCustomer: string;
  targetIndustry: string;
  pricePoint: string;
  developmentTimeline: string;
};

export type IdeaAnalysis = {
  opportunityScore: number;
  topRisks: string[];
  topOpportunities: string[];
  firstCustomerProfile: string;
  suggestedLaunchTimeline: string;
  recommendation: "BUILD" | "PIVOT" | "ABANDON";
  rationale: string;
};

export type Provenance = {
  source: "live" | "mixed" | "fallback";
  retrievedAt: string;
  confidence: number;
  gaps: string[];
};

export type ApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

export type ClientSummary = {
  id: string;
  name: string;
  companyName?: string;
  email: string;
  status: string;
  aiScore?: number;
  nextFollowUpAt?: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  domain?: string;
  description?: string;
};

export type ProductSummary = {
  id: string;
  name: string;
  status: string;
  marketScore?: number;
  monthlyRevenue?: number;
};

export type ReminderSummary = {
  id: string;
  title: string;
  dueAt: string;
  status: string;
  type: string;
};

export type ClientInteractionInput = {
  summary: string;
  type?: string;
  channel?: string;
  sentiment?: "positive" | "neutral" | "negative";
  nextAction?: string;
  occurredAt?: string;
};

export type ReminderInput = {
  title: string;
  dueAt: string;
  description?: string;
  type?: string;
  status?: string;
  aiSuggested?: boolean;
  clientId?: string;
};

export type InsightItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  generatedAt: string;
  isRead: boolean;
  confidenceScore?: number;
};

export type IdeaMemoryRecord = {
  id: string;
  createdAt: string;
  title: string;
  summary: string;
  recommendation: string;
  confidenceScore: number;
};

export type HelenaPrecisionBoard = {
  generatedAt: string;
  confidenceTrend: Array<{ date: string; value: number }>;
  failureTrend: Array<{ date: string; value: number }>;
  recommendedTargets: {
    sftExamplesTarget: number;
    dpoPairsTarget: number;
    datasetActions: string[];
  };
  rolloutGate: {
    canPromote: boolean;
    reasons: string[];
    thresholds: {
      minConfidenceDelta: number;
      minRelevanceDelta: number;
      minSuccessRate: number;
    };
    current: {
      timestamp: string;
      confidenceScore: number;
      relevanceScore: number;
      successRate: number;
      failureRate: number;
      lowConfidenceRate: number;
      sampleCount: number;
    };
    previous: {
      timestamp: string;
      confidenceScore: number;
      relevanceScore: number;
      successRate: number;
      failureRate: number;
      lowConfidenceRate: number;
      sampleCount: number;
    } | null;
  };
  provenance: Provenance;
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL && process.env.NEXT_PUBLIC_API_BASE_URL.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_BASE_URL.trim().replace(/\/$/, "")
    : "http://localhost:4000/api/v1";

function getAuthHeaders(): HeadersInit {
  if (typeof window === "undefined") {
    return {};
  }

  const token = window.localStorage.getItem("reex_access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const payload = (await response.json()) as ApiEnvelope<T> | T;
  if (payload && typeof payload === "object" && "data" in (payload as ApiEnvelope<T>)) {
    const data = (payload as ApiEnvelope<T>).data;
    if (data === undefined) {
      throw new Error("API response missing data payload.");
    }
    return data;
  }

  return payload as T;
}

function getErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
  }

  if (error instanceof Error) {
    const match = error.message.match(/\((\d{3})\)/);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("failed to fetch") || message.includes("networkerror") || message.includes("network request failed");
}

let telemetryDisabledUntil = 0;

function telemetryTemporarilyDisabled(): boolean {
  return telemetryDisabledUntil > Date.now();
}

function pauseTelemetry(): void {
  // Avoid spamming failed telemetry requests when backend is offline.
  telemetryDisabledUntil = Date.now() + 60_000;
}

function normalizeListEnvelope<T>(payload: unknown, preferredKey: string): { total: number; items: T[] } {
  if (Array.isArray(payload)) {
    return { total: payload.length, items: payload as T[] };
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const direct = Array.isArray(record[preferredKey]) ? (record[preferredKey] as T[]) : [];
    const fallback = Array.isArray(record.items) ? (record.items as T[]) : [];
    const items = direct.length > 0 ? direct : fallback;
    const total = typeof record.total === "number" ? record.total : items.length;
    return { total, items };
  }

  return { total: 0, items: [] };
}

export async function getDailyBriefing(): Promise<{
  generatedAt: string;
  overview: { momentum: string; headline: string };
  topSignals: string[];
  provenance: Provenance;
}> {
  return apiRequest("/ai/daily-briefing");
}

export async function getAiInsights(): Promise<{
  total: number;
  unreadCount: number;
  insights: InsightItem[];
  provenance: Provenance;
}> {
  return apiRequest("/ai/insights");
}

export async function getRevenueAnalytics(): Promise<{
  monthToDateRevenue: number;
  plannedRevenue: number;
  variance: number;
  productMrr: number;
}> {
  return apiRequest("/analytics/revenue");
}

export async function getPipelineAnalytics(): Promise<{
  leads: number;
  qualified: number;
  active: number;
  won: number;
  lost: number;
  total: number;
  winRate: number | null;
}> {
  return apiRequest("/analytics/pipeline");
}

export async function getProjectAnalytics(): Promise<{
  totalProjects: number;
  averageHealthScore: number | null;
  atRiskProjects: number;
}> {
  return apiRequest("/analytics/projects");
}

export async function listProjects(): Promise<{ total: number; projects: ProjectSummary[] }> {
  const payload = await apiRequest<unknown>("/projects");

  if (Array.isArray(payload)) {
    return { total: payload.length, projects: payload as ProjectSummary[] };
  }

  if (payload && typeof payload === "object") {
    const record = payload as { total?: unknown; projects?: unknown; items?: unknown };
    const projects = Array.isArray(record.projects)
      ? (record.projects as ProjectSummary[])
      : Array.isArray(record.items)
        ? (record.items as ProjectSummary[])
        : [];
    const total = typeof record.total === "number" ? record.total : projects.length;
    return { total, projects };
  }

  return { total: 0, projects: [] };
}

export async function getProjectDetail(projectId: string): Promise<Record<string, unknown>> {
  return apiRequest(`/projects/${projectId}`);
}

export async function getProjectMonitor(projectId: string): Promise<Record<string, unknown>> {
  return apiRequest(`/projects/${projectId}/monitor`);
}

export async function listClients(): Promise<{ total: number; clients: ClientSummary[] }> {
  const payload = await apiRequest<unknown>("/clients");
  const normalized = normalizeListEnvelope<ClientSummary>(payload, "clients");
  return { total: normalized.total, clients: normalized.items };
}

export async function createClient(payload: {
  name: string;
  email: string;
  industry?: string;
  companyName?: string;
  status?: string;
}): Promise<ClientSummary> {
  return apiRequest("/clients", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateClient(id: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return apiRequest(`/clients/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function getClient(id: string): Promise<Record<string, unknown>> {
  return apiRequest(`/clients/${id}`);
}

export async function getClientAiProfile(id: string): Promise<Record<string, unknown>> {
  return apiRequest(`/clients/${id}/ai-profile`);
}

export async function listProducts(): Promise<{ total: number; products: ProductSummary[] }> {
  const payload = await apiRequest<unknown>("/products");
  const normalized = normalizeListEnvelope<ProductSummary>(payload, "products");
  return { total: normalized.total, products: normalized.items };
}

export async function getProduct(id: string): Promise<Record<string, unknown>> {
  return apiRequest(`/products/${id}`);
}

export async function getProductMarket(id: string): Promise<Record<string, unknown>> {
  return apiRequest(`/products/${id}/market`);
}

export async function getProductForecast(id: string): Promise<Record<string, unknown>> {
  return apiRequest(`/products/${id}/forecast`);
}

export async function listReminders(): Promise<{ total: number; reminders: ReminderSummary[] }> {
  const payload = await apiRequest<unknown>("/reminders");
  const normalized = normalizeListEnvelope<ReminderSummary>(payload, "reminders");
  return { total: normalized.total, reminders: normalized.items };
}

export async function scoreClient(payload: {
  accountName: string;
  industry: string;
  urgencyLevel: string;
  painPoints?: string[];
}): Promise<{ recommendation: string; fitScore: number; reasons: string[] }> {
  return apiRequest("/ai/score-client", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function generatePitch(payload: {
  clientName: string;
  productName: string;
  objective: string;
}): Promise<{ title: string; content: string }> {
  return apiRequest("/ai/generate-pitch", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logClientInteraction(clientId: string, payload: ClientInteractionInput): Promise<Record<string, unknown>> {
  return apiRequest(`/clients/${clientId}/interactions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createReminder(payload: ReminderInput): Promise<Record<string, unknown>> {
  return apiRequest("/reminders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function analyzeWebsite(url: string): Promise<Record<string, unknown>> {
  return apiRequest("/intelligence/analyze", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export async function getMarketingCalendar(): Promise<{ total: number; posts: Array<Record<string, unknown>> }> {
  return apiRequest("/marketing/calendar");
}

export async function generateMarketingPost(payload: {
  platform: string;
  topic: string;
  tone: string;
  goal: string;
  productId?: string;
}): Promise<Record<string, unknown>> {
  return apiRequest("/marketing/generate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function orchestrateMarketing(payload: {
  campaignHorizonWeeks?: number;
  focusGoal?: "PIPELINE" | "CONVERSION" | "RETENTION";
  marketContext?: string;
}): Promise<Record<string, unknown>> {
  return apiRequest("/marketing/orchestrate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function aiChat(message: string): Promise<{ role: string; content: string }> {
  const response = await fetch(`${API_BASE}/ai/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new Error(`Chat request failed (${response.status})`);
  }

  if (!response.body) {
    throw new Error("No response body from chat endpoint.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }

  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].startsWith("data:") ? lines[i].slice(5).trim() : lines[i];
    try {
      const parsed = JSON.parse(line) as { role?: string; content?: string };
      if (parsed.content) {
        return { role: parsed.role ?? "assistant", content: parsed.content };
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  throw new Error("Unable to parse chat stream response.");
}

export type IntelligenceChatProgress = {
  phase: string;
  detail?: string;
  generatedAt?: string;
};

export type IntelligenceChatCompleted = {
  response: string;
  actions: string[];
  actionCards?: Array<{
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
  }>;
  confidence?: number;
  model?: string;
  provenance?: Provenance;
};

export async function streamIntelligenceChat(
  input: { message: string; context?: Record<string, unknown> },
  handlers?: {
    onStarted?: (payload: IntelligenceChatProgress) => void;
    onProgress?: (payload: IntelligenceChatProgress) => void;
    onCompleted?: (payload: IntelligenceChatCompleted) => void;
  }
): Promise<IntelligenceChatCompleted> {
  const response = await fetch(`${API_BASE}/intelligence/chat/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Intelligence chat failed (${response.status})`);
  }

  if (!response.body) {
    throw new Error("No response body from intelligence chat endpoint.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedPayload: IntelligenceChatCompleted | null = null;

  const handleSseFrame = (frame: string): void => {
    const lines = frame.split("\n");
    let eventName = "message";
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const rawData = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    if (eventName === "started") {
      handlers?.onStarted?.(parsed as IntelligenceChatProgress);
      return;
    }

    if (eventName === "progress") {
      handlers?.onProgress?.(parsed as IntelligenceChatProgress);
      return;
    }

    if (eventName === "completed") {
      completedPayload = parsed as IntelligenceChatCompleted;
      handlers?.onCompleted?.(completedPayload);
      return;
    }

    if (eventName === "error") {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message?: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : "Intelligence chat stream failed.";
      throw new Error(message);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame) {
        handleSseFrame(frame);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  const trailing = buffer.trim();
  if (trailing.length > 0) {
    handleSseFrame(trailing);
  }

  if (!completedPayload) {
    throw new Error("Intelligence chat stream ended without a completion payload.");
  }

  return completedPayload;
}

export async function getHelenaPrecisionBoard(): Promise<HelenaPrecisionBoard> {
  return apiRequest("/intelligence/helena/precision/board");
}

function fallbackAnalysis(input: IdeaInput): IdeaAnalysis {
  const scoreBase = Math.min(95, 55 + Math.floor(input.description.length / 12));
  const recommendation = scoreBase > 75 ? "BUILD" : scoreBase > 62 ? "PIVOT" : "ABANDON";

  return {
    opportunityScore: scoreBase,
    topRisks: [
      "Distribution strategy is not yet concrete.",
      "Timeline may be optimistic for initial scope.",
      "Competitive moat is not fully defined.",
      "Price sensitivity needs customer validation.",
      "Customer onboarding complexity unclear.",
    ],
    topOpportunities: [
      `Strong fit signal in ${input.targetIndustry}.`,
      "Premium positioning possible with focused feature bundle.",
      "Early partnerships can accelerate trust.",
      "Opportunity for workflow automation differentiation.",
      "Fast MVP feedback cycles can de-risk launch.",
    ],
    firstCustomerProfile: `${input.targetCustomer} at 20-100 person teams with recurring workflow pain.`,
    suggestedLaunchTimeline: "6-10 weeks for MVP, then pilot rollout in week 12.",
    recommendation,
    rationale:
      recommendation === "BUILD"
        ? "The idea has sufficient demand and clear pain alignment to justify execution."
        : recommendation === "PIVOT"
          ? "Core opportunity exists, but positioning and go-to-market assumptions should be refined first."
          : "Risk concentration is high; validate demand before allocating major build resources.",
  };
}

export async function analyzeIdea(input: IdeaInput): Promise<IdeaAnalysis> {
  try {
    const res = await fetch(`${API_BASE}/ai/analyze-idea`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      return fallbackAnalysis(input);
    }

    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const parsed = (await res.json()) as Partial<IdeaAnalysis>;
      if (typeof parsed.opportunityScore === "number") {
        return {
          opportunityScore: parsed.opportunityScore,
          topRisks: parsed.topRisks ?? [],
          topOpportunities: parsed.topOpportunities ?? [],
          firstCustomerProfile: parsed.firstCustomerProfile ?? "",
          suggestedLaunchTimeline: parsed.suggestedLaunchTimeline ?? "",
          recommendation: (parsed.recommendation as IdeaAnalysis["recommendation"]) ?? "PIVOT",
          rationale: parsed.rationale ?? "",
        };
      }
    }

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].startsWith("data:") ? lines[i].slice(5).trim() : lines[i];
        try {
          const parsed = JSON.parse(line) as Partial<IdeaAnalysis>;
          if (typeof parsed.opportunityScore === "number") {
            return {
              opportunityScore: parsed.opportunityScore,
              topRisks: parsed.topRisks ?? [],
              topOpportunities: parsed.topOpportunities ?? [],
              firstCustomerProfile: parsed.firstCustomerProfile ?? "",
              suggestedLaunchTimeline: parsed.suggestedLaunchTimeline ?? "",
              recommendation: (parsed.recommendation as IdeaAnalysis["recommendation"]) ?? "PIVOT",
              rationale: parsed.rationale ?? "",
            };
          }
        } catch {
          // Ignore non-JSON SSE frame lines.
        }
      }
    }

    return fallbackAnalysis(input);
  } catch {
    return fallbackAnalysis(input);
  }
}

export async function saveIdeaMemory(payload: {
  title: string;
  summary: string;
  recommendation: string;
  confidenceScore: number;
  analysis: IdeaAnalysis;
}): Promise<{ ok: boolean }> {
  try {
    return await apiRequest("/intelligence/idea/memory", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 401 || status === 403 || isNetworkFailure(error)) {
      return { ok: false };
    }
    throw error;
  }
}

export async function listIdeaMemory(limit = 5): Promise<{ records: IdeaMemoryRecord[] }> {
  try {
    return await apiRequest(`/intelligence/idea/memory?limit=${limit}`);
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 401 || status === 403 || isNetworkFailure(error)) {
      return { records: [] };
    }
    throw error;
  }
}

export async function postTelemetryEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  if (telemetryTemporarilyDisabled()) {
    return;
  }

  try {
    await apiRequest("/telemetry/events", {
      method: "POST",
      body: JSON.stringify({ event, properties, source: "frontend" })
    });
  } catch (error) {
    if (isNetworkFailure(error) || getErrorStatus(error) === 401) {
      pauseTelemetry();
      return;
    }
    return;
  }
}

export async function postTelemetryError(
  message: string,
  options?: { stack?: string; context?: Record<string, unknown> }
): Promise<void> {
  if (telemetryTemporarilyDisabled()) {
    return;
  }

  try {
    await apiRequest("/telemetry/errors", {
      method: "POST",
      body: JSON.stringify({
        message,
        stack: options?.stack,
        context: options?.context,
        source: "frontend"
      })
    });
  } catch (error) {
    if (isNetworkFailure(error) || getErrorStatus(error) === 401) {
      pauseTelemetry();
      return;
    }
    return;
  }
}

// Company Settings API
export type CompanySettings = {
  id: string;
  companyName: string;
  industry: string;
  teamSize?: number;
  monthlyRevenueTarget?: number;
  primaryMarket: string;
  coreServices?: string;
  competitiveAdvantage?: string;
  currentChallenges?: string;
  idealClientProfile?: string;
  productionTechStack?: string;
  tavilyApiKey?: string | null;
  anthropicApiKey?: string | null;
  updatedAt: string;
};

export async function getCompanySettings(): Promise<CompanySettings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch company settings: ${res.statusText}`);
  }

  const data = (await res.json()) as { data?: CompanySettings };
  return data.data || ({} as CompanySettings);
}

export async function updateCompanySettings(settings: Partial<CompanySettings>): Promise<CompanySettings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    throw new Error(`Failed to update company settings: ${res.statusText}`);
  }

  const data = (await res.json()) as { data?: CompanySettings };
  return data.data || ({} as CompanySettings);
}
