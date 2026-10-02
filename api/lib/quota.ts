import type { QuotaLimits } from "./config";

/**
 * The quota window is a UTC calendar day, so the reset moment is unambiguous
 * for every visitor: 00:00 UTC. The browser is expected to render that instant
 * in the visitor's own local time.
 */

/**
 * Why generation is currently unavailable, if it is. `ok` means a new attempt
 * would still be allowed. The distinction matters in the UI: a global ceiling
 * must never be described as "you used all of your personal previews".
 */
export type QuotaVariant = "ok" | "network" | "global" | "disabled";

export interface QuotaSnapshot {
  /** Paid attempts allowed per network per UTC day. */
  limit: number;
  /** Paid attempts already reserved against this network today (successful or not). */
  used: number;
  /** Effective remaining attempts: the smaller of the network and global headroom. */
  remaining: number;
  /** Remaining on this network's own ceiling, ignored when the global ceiling binds. */
  network_remaining: number;
  /** Remaining on the shared global ceiling for today. */
  global_remaining: number;
  /** True when a new paid attempt would be allowed right now. */
  available: boolean;
  /** `ok`, `network`, `global` or `disabled` — never inferred from `used`. */
  variant: QuotaVariant;
  /** ISO-8601 instant of the next UTC midnight. */
  reset_at: string;
  reset_in_seconds: number;
  /** Quota is per client network, not per browser. */
  scope: "network";
  /** True when paid generation is switched off by configuration. */
  disabled: boolean;
}

/** `YYYY-MM-DD` for the UTC day that `now` falls in. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcReset(now: Date = new Date()): {
  iso: string;
  epochSeconds: number;
  secondsRemaining: number;
} {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  const epochSeconds = Math.floor(next / 1000);
  const secondsRemaining = Math.max(0, Math.ceil((next - now.getTime()) / 1000));
  return { iso: new Date(next).toISOString(), epochSeconds, secondsRemaining };
}

export function buildQuotaSnapshot(
  limits: QuotaLimits,
  used: number,
  now: Date = new Date(),
  globalUsed = 0,
): QuotaSnapshot {
  const disabled = limits.userLimit <= 0 || limits.globalLimit <= 0;
  const limit = limits.userLimit;
  const usedSafe = Math.max(0, Math.floor(used));
  const globalUsedSafe = Math.max(0, Math.floor(globalUsed));
  const networkRemaining = Math.max(0, limit - usedSafe);
  const globalRemaining = Math.max(0, limits.globalLimit - globalUsedSafe);
  const remaining = disabled ? 0 : Math.min(networkRemaining, globalRemaining);
  const variant: QuotaVariant = disabled
    ? "disabled"
    : globalRemaining <= 0
      ? "global"
      : networkRemaining <= 0
        ? "network"
        : "ok";
  const reset = nextUtcReset(now);
  return {
    limit,
    used: usedSafe,
    remaining,
    network_remaining: disabled ? 0 : networkRemaining,
    global_remaining: disabled ? 0 : globalRemaining,
    available: !disabled && remaining > 0,
    variant,
    reset_at: reset.iso,
    reset_in_seconds: reset.secondsRemaining,
    scope: "network",
    disabled,
  };
}

/** Machine-readable reason returned by the reserve function. */
export type ReserveReason =
  | "ok"
  | "user_limit"
  | "global_limit"
  | "disabled"
  | "invalid_identity";

export interface ReserveResult {
  allowed: boolean;
  reason: ReserveReason;
  userCount: number;
  globalCount: number;
}

/** Maps a reserve reason onto the API error variant shown in the UI. */
export function quotaVariantFor(reason: ReserveReason): Exclude<QuotaVariant, "ok"> {
  if (reason === "global_limit") return "global";
  if (reason === "disabled") return "disabled";
  return "network";
}
