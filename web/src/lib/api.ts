import type { PreparedImage } from "./image";
import { classifyFetchFailure, countedFromDetails, unreadableOutcome, type CountedState } from "./outcome";

/**
 * Where `/api` lives.
 *
 * An empty value means **same origin**: the static site and its functions are
 * served by one Vercel project, so relative `/api/*` paths are correct and no
 * CORS is involved. A non-empty value points at a separately deployed API,
 * which is what local development uses to reach the mock server on another
 * port, and what a split frontend/API deployment would need.
 *
 * Same-origin is therefore a valid configuration, not a missing one — if the
 * service is genuinely unreachable, `/api/health` fails and the page says so.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
/**
 * The client always waits longer than the server's own generation timeout, so a
 * slow-but-successful preview is never killed early from this side.
 * Server default: GENERATION_TIMEOUT_MS=240000, Vercel maxDuration=300.
 */
export const GENERATION_TIMEOUT_MS = 270_000;
export const QUOTA_TIMEOUT_MS = 12_000;

export type QuotaVariant = "network" | "global" | "disabled";

export interface QuotaSnapshot {
  limit: number;
  used: number;
  remaining: number;
  network_remaining: number;
  global_remaining: number;
  available: boolean;
  variant: "ok" | "network" | "global" | "disabled";
  reset_at: string;
  reset_in_seconds: number;
  scope: "network";
  disabled: boolean;
}

export interface GenerateResponse {
  generation_id: string;
  image: string;
  quota: QuotaSnapshot;
  provider: string;
  mock: boolean;
}

export interface HealthResponse {
  ok: boolean;
  provider: string;
  mock: boolean;
  quotaConfigured?: boolean;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public variant?: QuotaVariant,
    /**
     * Whether this request spent a paid attempt: `true`/`false` come from the
     * server, `unknown` means the browser lost the response and cannot tell.
     */
    public counted: CountedState = "unknown",
    public quota?: QuotaSnapshot,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

interface ErrorPayload {
  error?: string;
  message?: string;
  details?: { variant?: QuotaVariant; counted?: unknown; quota?: QuotaSnapshot };
}

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

/** GET /api/quota — server truth for today's remaining previews. */
export async function fetchQuota(signal?: AbortSignal): Promise<{ quota: QuotaSnapshot; mock: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/quota`, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    const failure = classifyFetchFailure(error);
    throw new ApiError(failure.code, failure.message, 0, undefined, failure.counted);
  }
  const data = await readJson<{ quota?: QuotaSnapshot; provider?: string } & ErrorPayload>(response);
  if (!response.ok || !data?.quota) {
    throw new ApiError(
      data?.error ?? "quota_unavailable",
      data?.message ?? "Could not read today's preview limit.",
      response.status,
    );
  }
  return { quota: data.quota, mock: data.provider === "mock" };
}

/** GET /api/health — used to flag a local mock deployment in the UI. */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE}/api/health`, {
    signal,
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!response) throw new ApiError("network", "Could not reach the preview service.", 0);
  const data = await readJson<HealthResponse>(response);
  if (!response.ok || !data) {
    throw new ApiError("unavailable", "Could not reach the preview service.", response.status);
  }
  return data;
}

export interface GenerateOptions {
  npcId: string;
  prepared: PreparedImage;
  clientId: string;
  source?: string;
  campaign?: string;
  signal: AbortSignal;
}

/** POST /api/generate */
export async function requestGeneration(options: GenerateOptions): Promise<GenerateResponse> {

  const form = new FormData();
  form.append("npc_id", options.npcId);
  form.append("client_id", options.clientId);
  form.append("image", new File([options.prepared.blob], "dress.jpg", { type: "image/jpeg" }));
  if (options.source) form.append("utm_source", options.source);
  if (options.campaign) form.append("utm_campaign", options.campaign);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    // A rejected fetch may happen after the server already dispatched the paid
    // call, so the outcome is unknown — never "not charged".
    const failure = classifyFetchFailure(error);
    throw new ApiError(failure.code, failure.message, 0, undefined, failure.counted);
  }

  const data = await readJson<Partial<GenerateResponse> & ErrorPayload>(response);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const unreadable = unreadableOutcome();
    throw new ApiError(unreadable.code, unreadable.message, response.status, undefined, unreadable.counted);
  }
  if (!response.ok || !data.image) {
    if (!response.ok && typeof data.error === "string") {
      throw new ApiError(
        data.error,
        data.message ?? "The preview could not be generated. Please try again.",
        response.status,
        data.details?.variant,
        countedFromDetails(data.details),
        data.details?.quota,
      );
    }
    const unreadable = unreadableOutcome();
    throw new ApiError(
      unreadable.code,
      unreadable.message,
      response.status,
      undefined,
      unreadable.counted,
    );
  }

  return {
    generation_id: data.generation_id ?? "",
    image: data.image,
    quota: data.quota ?? {
      limit: 0,
      used: 0,
      remaining: 0,
      network_remaining: 0,
      global_remaining: 0,
      available: false,
      variant: "disabled",
      reset_at: "",
      reset_in_seconds: 0,
      scope: "network",
      disabled: false,
    },
    provider: data.provider ?? "unknown",
    mock: data.mock === true,
  };
}

export interface FeedbackPayload {
  generationId: string;
  rating: "yes" | "kind_of" | "no";
  feedbackText?: string;
  source?: string;
}

/** POST /api/feedback — text never leaves this call. */
export async function sendFeedback(payload: FeedbackPayload): Promise<void> {

  const response = await fetch(`${API_BASE}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      generation_id: payload.generationId,
      rating: payload.rating,
      feedback_text: payload.feedbackText,
      utm_source: payload.source,
    }),
  }).catch(() => null);

  if (!response || !response.ok) {
    throw new ApiError("feedback_failed", "Feedback could not be saved right now.", response?.status ?? 0);
  }
}
