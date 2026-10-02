/**
 * Honest bookkeeping for a paid attempt.
 *
 * The server knows whether it reserved and dispatched an attempt. The browser
 * does not: a timeout, a dropped connection or a non-JSON response can all
 * happen *after* the server spent one of today's previews. Those outcomes are
 * `unknown`, never `false`, and no copy in this file may ever claim an
 * unconfirmed attempt was free.
 */

export type CountedState = "true" | "false" | "unknown";

export interface AttemptDetails {
  counted?: unknown;
}

/** Translate the server's `counted` flag; anything missing or odd is `unknown`. */
export function countedFromDetails(details: AttemptDetails | undefined | null): CountedState {
  if (details && details.counted === true) return "true";
  if (details && details.counted === false) return "false";
  return "unknown";
}

/** One short sentence about what a failed attempt did to today's allowance. */
export function failureChargeNote(counted: CountedState): string {
  switch (counted) {
    case "true":
      return "It used one of today's previews, because the AI had already started.";
    case "false":
      return "None of today's previews were used.";
    default:
      return "We could not confirm whether this attempt was counted. It may have used one of today's previews — the counter below is refreshing now.";
  }
}

export interface FetchFailure {
  code: "timeout" | "network";
  counted: CountedState;
  message: string;
}

/**
 * Classify a rejected `fetch` (abort, timeout, dropped connection). The outcome
 * is always `unknown`: the request may already have reached the server.
 */
export function classifyFetchFailure(error: unknown): FetchFailure {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: string }).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      code: "timeout",
      counted: "unknown",
      message: "The preview did not finish in time. The attempt may have been used.",
    };
  }
  return {
    code: "network",
    counted: "unknown",
    message: "The connection dropped before we could confirm the result. The attempt may have been used.",
  };
}

/** A response we could not read (for example an HTML error page from a proxy). */
export function unreadableOutcome(): { code: "unknown"; counted: CountedState; message: string } {
  return {
    code: "unknown",
    counted: "unknown",
    message: "The service sent an unreadable response, so we could not confirm the result. The attempt may have been used.",
  };
}

export type QuotaState = "checking" | "fresh" | "stale";

export interface AvailabilityInput {
  /** False when this build has no API origin configured at all. */
  apiConfigured: boolean;
  /** `fresh` only after a successful, authoritative quota read. */
  quotaState: QuotaState;
  /** Last known snapshot, kept for display even when the read has gone stale. */
  quota: { available: boolean } | null;
  /** The visitor has picked a customer and a usable screenshot. */
  ready: boolean;
  busy: boolean;
}

/**
 * The single gate for starting a paid attempt. It fails closed: an unconfigured
 * API or a stale/unavailable quota answer disables generation until a refresh
 * succeeds, even though the last known numbers may still be on screen.
 */
export function generationAllowed(input: AvailabilityInput): boolean {
  return (
    input.apiConfigured &&
    input.quotaState === "fresh" &&
    Boolean(input.quota?.available) &&
    input.ready &&
    !input.busy
  );
}

export interface BlockedCopy {
  title: string;
  body: string;
  buttonLabel: string;
}

/**
 * Distinct copy for the three ways generation can be unavailable. The global
 * case must read as "the shared budget is spent", never as "you used all of your
 * previews" — the visitor may have used none of them.
 */
export function quotaBlockCopy(variant: "network" | "global" | "disabled"): BlockedCopy {
  switch (variant) {
    case "global":
      return {
        title: "Today's preview budget is spent.",
        body: "The shared daily budget for everyone has been reached, so previews are paused until the next reset. Your own allowance was not used up.",
        buttonLabel: "Today's budget is spent",
      };
    case "disabled":
      return {
        title: "Previews are paused right now.",
        body: "No previews are being generated at the moment. Please check back later.",
        buttonLabel: "Previews paused",
      };
    default:
      return {
        title: "You have used today's previews.",
        body: "They refresh after the daily reset.",
        buttonLabel: "Daily previews used up",
      };
  }
}
