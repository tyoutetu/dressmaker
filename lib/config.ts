import { ApiError } from "./errors.js";

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
 * Absolute product maximum for the per-network ceiling. `USER_DAILY_GENERATION_LIMIT`
 * may lower this or set it to zero, but an operator can never raise it: a value
 * above the product maximum is a mistake and fails closed instead of quietly
 * handing out more paid attempts than the product allows.
 *
 * Networks listed in `QUOTA_UNLIMITED_IPS` are exempt from this ceiling — see
 * `isUnlimitedNetwork`. That exemption is per-network and never lifts the global
 * budget, so it cannot raise the day's worst-case spend.
 */
export const USER_DAILY_GENERATION_LIMIT_MAX = 3;

/**
 * Networks that skip the per-network daily ceiling.
 *
 * This exists for the operator testing their own deployment: everyone else keeps
 * the product's three-a-day ceiling, while the listed addresses are limited only
 * by the global budget. Costs stay bounded because the global ceiling still
 * applies — an exempt network can consume the shared budget, not exceed it.
 *
 * Matching is on the exact canonical address, deliberately: a prefix or range
 * match would silently exempt strangers who happen to share a subnet, and a
 * shared VPN exit is exactly where that goes wrong.
 *
 * The addresses live in server configuration, are never written to the database
 * and are never logged; only their HMAC reaches the quota tables, as for every
 * other visitor.
 */
export function readUnlimitedNetworks(env: Env = process.env): string[] {
  return (env.QUOTA_UNLIMITED_IPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** True when this network is exempt from the per-network ceiling. */
export function isUnlimitedNetwork(ip: string, env: Env = process.env): boolean {
  const list = readUnlimitedNetworks(env);
  return list.length > 0 && list.includes(ip);
}

/**
 * Read the daily cost ceilings. A malformed value fails closed instead of
 * silently widening the limit. `GLOBAL_DAILY_GENERATION_LIMIT=0` is a
 * deliberate kill switch that disables all paid generation.
 *
 * `unlimitedNetwork` raises only the *per-network* figure — to the global
 * budget, so an exempt network may use the whole day's allowance without the
 * per-network check ever binding first. The global figure is unchanged, which is
 * what keeps the exemption cost-neutral. When the global limit is 0 the kill
 * switch still wins and the exempt network is disabled along with everyone else.
 */
export function readQuotaLimits(
  env: Env = process.env,
  options: { unlimitedNetwork?: boolean } = {},
): QuotaLimits {
  const globalLimit = readNonNegativeInt(env, "GLOBAL_DAILY_GENERATION_LIMIT", 100);
  const userLimit = options.unlimitedNetwork
    ? globalLimit
    : readConfiguredUserLimit(env, globalLimit);
  return { userLimit, globalLimit };
}

function readConfiguredUserLimit(env: Env, globalLimit: number): number {
  const userLimit = readNonNegativeInt(env, "USER_DAILY_GENERATION_LIMIT", USER_DAILY_GENERATION_LIMIT_MAX);
  if (userLimit > USER_DAILY_GENERATION_LIMIT_MAX) {
    throw new ApiError(
      "service_unavailable",
      503,
      `USER_DAILY_GENERATION_LIMIT must be between 0 and ${USER_DAILY_GENERATION_LIMIT_MAX}; got ${userLimit}.`,
    );
  }
  return userLimit;
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
