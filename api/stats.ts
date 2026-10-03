import { timingSafeEqual } from "node:crypto";
import { getDb, readUsageStats } from "../lib/db.js";
import { utcDayKey } from "../lib/quota.js";

/**
 * GET /api/stats — what the site has actually been used for.
 *
 * Off unless `STATS_TOKEN` is set, and unset is the default: an operator who
 * never asks for this endpoint cannot accidentally expose it. There is no
 * fallback value and no "development default", because a guessable token on a
 * public URL is the same as no token at all.
 *
 * The token is compared in constant time. The response carries aggregates only —
 * no identifiers of any kind, which is also why this endpoint deliberately sends
 * no CORS headers: a cross-origin page cannot read the body even if it somehow
 * obtained the token.
 *
 * `?token=` is accepted for the convenience of opening this in a browser, but
 * that puts the token in browser history and in platform request logs; the
 * `Authorization: Bearer` form avoids both and is what a script should use.
 */
export async function route(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const expected = (process.env.STATS_TOKEN ?? "").trim();
  // Below the length floor the secret is not worth calling a secret.
  if (expected.length < 16) {
    return json({ error: "not_found" }, 404);
  }

  const provided =
    bearer(request.headers.get("authorization")) ??
    new URL(request.url).searchParams.get("token") ??
    "";
  if (!matches(provided, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const stats = await readUsageStats(getDb(), utcDayKey());
    return json({ ok: true, stats }, 200);
  } catch (err) {
    console.error("[stats] failed", err instanceof Error ? err.message : err);
    return json({ error: "stats_unavailable" }, 503);
  }
}

function bearer(header: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return match ? match[1].trim() : null;
}

/** Length-independent, content-constant-time comparison. */
function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still compare something of equal length so the timing does not reveal
    // where the first difference was.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default { fetch: route };
