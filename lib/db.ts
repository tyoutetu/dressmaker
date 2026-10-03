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

export interface UsageWindow {
  /** Distinct networks that spent at least one attempt in the window. */
  networks: number;
  /** Paid attempts reserved in the window (the quota counters). */
  attempts: number;
  succeeded: number;
  failed: number;
}

export interface UsageStats {
  today: string;
  windows: { today: UsageWindow; last7: UsageWindow; last30: UsageWindow };
  allTime: {
    attempts: number;
    succeeded: number;
    failed: number;
    networks: number;
    estimatedCost: number;
    avgLatencyMs: number | null;
    maxLatencyMs: number | null;
    firstAt: string | null;
    lastAt: string | null;
  };
  byNpc: Array<{ npcId: string; attempts: number; succeeded: number; failed: number }>;
  failures: Array<{ errorType: string; count: number }>;
  sources: Array<{ source: string; count: number }>;
}

/**
 * Read-only rollup of what the site has actually been used for.
 *
 * Two different tables answer two different questions, and they are kept apart
 * on purpose: `usage_daily` is the quota ledger — one row per network per day,
 * so its row count is "how many networks used this" — while `generations` is the
 * outcome log. Counting people from `generations` would double-count a network
 * that tried five times; counting spend from `usage_daily` would miss the
 * attempts that were refused before reaching the provider.
 *
 * No identifier is returned: `ip_hash` is already an HMAC with no raw address
 * behind it, and it is only ever aggregated, never listed.
 */
export async function readUsageStats(db: Sql, today: string): Promise<UsageStats> {
  const windowRows = (await db`
    with w(label, since) as (
      values ('today', ${today}::date), ('last7', ${today}::date - 6), ('last30', ${today}::date - 29)
    )
    select
      w.label,
      (select count(*) from usage_daily u where u.usage_date >= w.since) as networks,
      (select coalesce(sum(u.count), 0) from usage_daily u where u.usage_date >= w.since) as attempts,
      (select count(*) from generations g
        where g.created_at >= w.since::timestamptz and g.status = 'success') as succeeded,
      (select count(*) from generations g
        where g.created_at >= w.since::timestamptz and g.status = 'failed') as failed
    from w
  `) as Array<{
    label: string;
    networks: number | string;
    attempts: number | string;
    succeeded: number | string;
    failed: number | string;
  }>;

  const windowFor = (label: string): UsageWindow => {
    const row = windowRows.find((r) => r.label === label);
    return {
      networks: Number(row?.networks ?? 0),
      attempts: Number(row?.attempts ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  };

  const totalsRows = (await db`
    select
      count(*) as attempts,
      count(*) filter (where status = 'success') as succeeded,
      count(*) filter (where status = 'failed') as failed,
      count(distinct client_ip_hash) as networks,
      coalesce(sum(estimated_cost), 0) as estimated_cost,
      avg(latency_ms) as avg_latency,
      max(latency_ms) as max_latency,
      min(created_at) as first_at,
      max(created_at) as last_at
    from generations
  `) as Array<Record<string, unknown>>;
  const t = totalsRows[0] ?? {};

  const npcRows = (await db`
    select npc_id,
           count(*) as attempts,
           count(*) filter (where status = 'success') as succeeded,
           count(*) filter (where status = 'failed') as failed
    from generations group by npc_id order by attempts desc
  `) as Array<Record<string, unknown>>;

  const failureRows = (await db`
    select coalesce(error_type, 'unknown') as error_type, count(*) as count
    from generations where status = 'failed' group by 1 order by count desc limit 10
  `) as Array<Record<string, unknown>>;

  const sourceRows = (await db`
    select coalesce(nullif(source, ''), '(direct)') as source, count(*) as count
    from generations group by 1 order by count desc limit 10
  `) as Array<Record<string, unknown>>;

  const num = (v: unknown): number => Number(v ?? 0) || 0;
  const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

  return {
    today,
    windows: { today: windowFor("today"), last7: windowFor("last7"), last30: windowFor("last30") },
    allTime: {
      attempts: num(t.attempts),
      succeeded: num(t.succeeded),
      failed: num(t.failed),
      networks: num(t.networks),
      estimatedCost: num(t.estimated_cost),
      avgLatencyMs: t.avg_latency == null ? null : Math.round(num(t.avg_latency)),
      maxLatencyMs: t.max_latency == null ? null : num(t.max_latency),
      firstAt: iso(t.first_at),
      lastAt: iso(t.last_at),
    },
    byNpc: npcRows.map((r) => ({
      npcId: String(r.npc_id ?? "unknown"),
      attempts: num(r.attempts),
      succeeded: num(r.succeeded),
      failed: num(r.failed),
    })),
    failures: failureRows.map((r) => ({
      errorType: String(r.error_type ?? "unknown"),
      count: num(r.count),
    })),
    sources: sourceRows.map((r) => ({ source: String(r.source ?? "?"), count: num(r.count) })),
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
