import { ApiError } from "./errors";

type Env = Record<string, string | undefined>;

/**
 * Configuration is read from the server environment only. Nothing a client
 * sends can change the model, the endpoint or the API key, and every failure
 * below happens *before* a paid provider call, so it costs nothing.
 */

export function isVercelRuntime(env: Env = process.env): boolean {
  return (env.VERCEL ?? "").trim() === "1";
}

/**
 * Explicit, opt-in loopback mode for local development and the local mock.
 * It is hard-disabled on the Vercel platform: a deployment can never fall back
 * to a shared "local" identity just because the trusted header is absent.
 */
export function isLocalQuotaMode(env: Env = process.env): boolean {
  if (isVercelRuntime(env)) return false;
  return (env.ALLOW_LOCAL_QUOTA_MODE ?? "").trim().toLowerCase() === "true";
}

export interface QuotaLimits {
  /** Paid generation attempts allowed per client network per UTC day. */
  userLimit: number;
  /** Paid generation attempts allowed across all clients per UTC day. */
  globalLimit: number;
}

/**
 * Sanity ceiling for the per-network limit. `USER_DAILY_GENERATION_LIMIT` may be
 * anything from 0 up to this; a larger value is treated as a typo and fails
 * closed rather than quietly handing out more paid attempts than intended.
 *
 * This is deliberately **not** the product's cost ceiling. The ceiling is
 * `GLOBAL_DAILY_GENERATION_LIMIT`, which caps spend across every network
 * together; the per-network limit only decides how that shared budget is shared
 * out. Raising it therefore cannot increase the worst-case daily spend — it
 * only lets one network consume more of the budget that already exists. Setting
 * the per-network limit at or above the global one makes it non-binding, which
 * is what a single-operator deployment wants.
 */
export const USER_DAILY_GENERATION_LIMIT_MAX = 100;

/**
 * Read the daily cost ceilings. A malformed value fails closed instead of
 * silently widening the limit. `GLOBAL_DAILY_GENERATION_LIMIT=0` is a
 * deliberate kill switch that disables all paid generation.
 */
export function readQuotaLimits(env: Env = process.env): QuotaLimits {
  const userLimit = readNonNegativeInt(env, "USER_DAILY_GENERATION_LIMIT", USER_DAILY_GENERATION_LIMIT_MAX);
  if (userLimit > USER_DAILY_GENERATION_LIMIT_MAX) {
    throw new ApiError(
      "service_unavailable",
      503,
      `USER_DAILY_GENERATION_LIMIT must be between 0 and ${USER_DAILY_GENERATION_LIMIT_MAX}; got ${userLimit}.`,
    );
  }
  return {
    userLimit,
    globalLimit: readNonNegativeInt(env, "GLOBAL_DAILY_GENERATION_LIMIT", 100),
  };
}

function readNonNegativeInt(env: Env, key: string, fallback: number): number {
  const raw = (env[key] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ApiError(
      "service_unavailable",
      503,
      `${key} must be a non-negative integer, got a malformed value.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError("service_unavailable", 503, `${key} is out of range.`);
  }
  return value;
}

/**
 * The HMAC key used to pseudonymize client IPs. Required in production; when it
 * is missing the quota fails closed rather than storing a weak/reversible hash.
 */
export function readIpHashSecret(env: Env = process.env): string {
  const secret = (env.IP_HASH_SECRET ?? "").trim();
  if (secret.length >= 16) return secret;
  if (isLocalQuotaMode(env)) {
    return "local-development-only-secret-do-not-deploy";
  }
  throw new ApiError(
    "service_unavailable",
    503,
    "IP_HASH_SECRET is not configured (or is shorter than 16 characters).",
  );
}

export function readPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = (env[key] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Finite non-negative decimal, or `undefined` when unset or malformed. Used for
 * the ops-only USD cost estimates: `0.03` must survive verbatim, and a missing
 * value must stay missing rather than becoming a fabricated provider price.
 */
export function readNonNegativeDecimal(env: Env, key: string): number | undefined {
  const raw = (env[key] ?? "").trim();
  if (raw === "") return undefined;
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}
