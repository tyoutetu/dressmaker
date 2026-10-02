/** Small formatting helpers shared by the quota meter and the status copy. */

/** "00:00 UTC" plus the visitor's own local equivalent of the same instant. */
export function formatResetMoment(resetAt: string | undefined): string {
  const local = formatLocalTime(resetAt);
  return local ? `00:00 UTC (${local} your time)` : "00:00 UTC";
}

function formatLocalTime(resetAt: string | undefined): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.max(0, safe)}s`;
}

/** Seconds until a reset instant, recomputed against the current clock. */
export function secondsUntil(resetAt: string | undefined, now: number = Date.now()): number | null {
  if (!resetAt) return null;
  const target = Date.parse(resetAt);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.round((target - now) / 1000));
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
