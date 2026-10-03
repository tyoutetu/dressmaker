import { neon } from "@neondatabase/serverless";
import type { QuotaLimits } from "./config.js";
import { ApiError } from "./errors.js";
import type { ReserveReason, ReserveResult } from "./quota.js";

/**
 * Neon Postgres over HTTP. Every statement is a single round trip, which is why
 * the whole quota reservation lives in one SQL function: the per-network and
 * global counters must move together, before the paid provider call, no matter
 * how many function instances run concurrently.
 */

export type Sql = ReturnType<typeof neon>;

let cached: Sql | null = null;
let testClient: Sql | null = null;

/** Test seam: lets the test suite run the real SQL against PGlite. */
export function setDbForTests(client: Sql | null): void {
  testClient = client;
  cached = null;
}

/** Lazily create the Neon HTTP SQL client. Fails closed when unconfigured. */
export function getDb(): Sql {
  if (testClient) return testClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new ApiError("service_unavailable", 503, "DATABASE_URL is not configured.");
  }
  if (!cached) cached = neon(url);
  return cached;
}

/**
 * Atomically reserve one paid attempt for this network, consuming both the
 * per-network and the global daily counter. Returns `allowed: false` with a
 * reason when a ceiling is already reached — in that case nothing was charged.
 */
export async function reserveQuota(
  db: Sql,
  ipHash: string,
  limits: QuotaLimits,
  usageDate: string,
): Promise<ReserveResult> {
  const rows = (await db`
    select allowed, reason, user_count, global_count
    from reserve_generation_quota(
      ${ipHash},
      ${limits.userLimit},
      ${limits.globalLimit},
      ${usageDate}::date
    )
  `) as Array<{
    allowed: boolean;
    reason: string;
    user_count: number;
    global_count: number;
  }>;

  const row = rows[0];
  if (!row) {
    throw new ApiError("quota_unavailable", 503, "Quota reservation returned no result.");
  }
  return {
    allowed: row.allowed === true,
    reason: row.reason as ReserveReason,
    userCount: Number(row.user_count) || 0,
    globalCount: Number(row.global_count) || 0,
  };
}

/** Read-only view of today's counters for the quota endpoint. Never creates rows. */
export async function readQuotaCounters(
  db: Sql,
  ipHash: string,
  usageDate: string,
): Promise<{ userCount: number; globalCount: number }> {
  const userRows = (await db`
    select count from usage_daily
    where usage_date = ${usageDate}::date and ip_hash = ${ipHash}
  `) as Array<{ count: number }>;

  const globalRows = (await db`
    select count from global_usage_daily where usage_date = ${usageDate}::date
  `) as Array<{ count: number }>;

  return {
    userCount: Number(userRows[0]?.count ?? 0),
    globalCount: Number(globalRows[0]?.count ?? 0),
  };
}

export interface GenerationRowInput {
  /** Browser-side analytics id. Never used for quota decisions. */
  clientId?: string;
  /** HMAC hash of the trusted client IP. Never the raw address. */
  ipHash?: string;
  npcId: string;
  source?: string;
  campaign?: string;
  status: "success" | "failed";
  provider?: string;
  model?: string;
  latencyMs: number;
  estimatedCost?: number;
  errorType?: string;
  /** True once a paid provider attempt was dispatched for this request. */
  counted: boolean;
}

export async function insertGeneration(
  db: Sql,
  row: GenerationRowInput,
): Promise<string | null> {
  try {
    const result = (await db`
      insert into generations
        (client_id, client_ip_hash, npc_id, source, campaign, status, provider, model,
         latency_ms, estimated_cost, error_type, counted)
      values
        (${row.clientId ?? null}, ${row.ipHash ?? null}, ${row.npcId}, ${row.source ?? null},
         ${row.campaign ?? null}, ${row.status}, ${row.provider ?? null}, ${row.model ?? null},
         ${row.latencyMs}, ${row.estimatedCost ?? null}, ${row.errorType ?? null}, ${row.counted})
      returning id
    `) as Array<{ id: string }>;
    return result[0]?.id ?? null;
  } catch (err) {
    // Telemetry must never mask the actual generation result.
    console.error("[db] insertGeneration failed", err);
    return null;
  }
}
