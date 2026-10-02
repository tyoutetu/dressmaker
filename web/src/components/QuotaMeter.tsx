import type { QuotaSnapshot } from "../lib/api";
import { formatCountdown, formatResetMoment, secondsUntil } from "../lib/format";

interface Props {
  quota: QuotaSnapshot | null;
  /** Current clock, so the countdown re-renders without extra timers. */
  now: number;
  /**
   * `fresh` means the last read succeeded and the numbers are authoritative.
   * Any other state disables generation but still shows the last known value.
   */
  state: "checking" | "fresh" | "stale";
  onRetry: () => void;
}

/**
 * The daily limit, always visible: it is the one number that decides whether a
 * visitor can generate, and it is enforced per network rather than per device.
 */
export function QuotaMeter({ quota, now, state, onRetry }: Props) {
  if (state !== "fresh") {
    const checking = state === "checking";
    return (
      <p className="quota quota-unknown" aria-live="polite">
        <span className="quota-count">
          {checking ? "Checking today's previews…" : "Preview limit unavailable"}
        </span>
        <span className="quota-reset">
          {checking
            ? "One moment."
            : quota
              ? `New previews are paused. Last known: ${quota.remaining} of ${quota.limit} left.`
              : "New previews are paused until the limit can be read."}
        </span>
        {!checking && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
            Check availability
          </button>
        )}
      </p>
    );
  }

  if (!quota) return null;

  if (quota.disabled) {
    return (
      <p className="quota quota-paused" aria-live="polite">
        <span className="quota-count">Previews are paused right now</span>
        <span className="quota-reset">No previews are being generated today.</span>
      </p>
    );
  }

  const remaining = quota.remaining;
  const seconds = secondsUntil(quota.reset_at, now) ?? 0;

  if (quota.variant === "global") {
    return (
      <p className="quota quota-global" aria-live="polite">
        <span className="quota-count">
          <strong>Today's preview budget is spent</strong>
        </span>
        <span className="quota-reset">
          Your network still has {quota.network_remaining} of {quota.limit}. Resets{" "}
          {formatResetMoment(quota.reset_at)} · in {formatCountdown(seconds)}
        </span>
      </p>
    );
  }

  // A very large configured limit should not turn the pill into a dot matrix.
  const dots = Math.min(Math.max(quota.limit, 0), 6);

  return (
    <p className="quota" aria-live="polite">
      <span className="quota-dots" aria-hidden="true">
        {Array.from({ length: dots }, (_, index) => (
          <span key={index} className={`quota-dot${index < remaining ? " is-left" : ""}`} />
        ))}
      </span>
      <span className="quota-count">
        <strong>{remaining}</strong> of {quota.limit} previews left today
      </span>
      <span className="quota-reset">
        Resets {formatResetMoment(quota.reset_at)} · in {formatCountdown(seconds)}
      </span>
    </p>
  );
}
