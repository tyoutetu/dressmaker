import { USER_MESSAGES, ApiError } from "../lib/errors.js";
import { corsHeaders, errorResponse, isOriginAllowed, json } from "../lib/env.js";
import { getDb, readQuotaCounters } from "../lib/db.js";
import { hashIp, resolveClientIp } from "../lib/ip.js";
import {
  isLocalQuotaMode,
  isUnlimitedNetwork,
  isVercelRuntime,
  readIpHashSecret,
  readQuotaLimits,
} from "../lib/config.js";
import { buildQuotaSnapshot, utcDayKey } from "../lib/quota.js";
import { DEFAULT_PROVIDER } from "../lib/provider.js";

/**
 * GET /api/quota — the visitor's remaining previews for today.
 *
 * Read-only: it never creates counters and never reserves anything. The client
 * calls it on load, when the tab regains focus and after the UTC rollover, so
 * the number on screen always reflects server truth rather than local state.
 *
 * The response reports *effective* availability: when the shared global ceiling
 * is reached, `remaining` is 0 and `variant` is `global`, so the UI can say the
 * day's preview budget is spent without implying the visitor used all of their
 * own attempts. The per-network numbers stay in the payload for that reason.
 */
export async function route(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", 405, USER_MESSAGES.method_not_allowed, request);
  }
  if (!isOriginAllowed(origin)) {
    return errorResponse("forbidden_origin", 403, USER_MESSAGES.forbidden_origin, request);
  }

  try {
    const identity = resolveClientIp(request.headers, {
      isVercel: isVercelRuntime(),
      localMode: isLocalQuotaMode(),
    });
    if (!identity.ok) {
      throw new ApiError("quota_unavailable", 503, "Trusted client identity unavailable.");
    }

    // Read-only, so it must report the same numbers the reservation would honour:
    // an exempt network sees the whole global budget rather than the product's
    // three-a-day ceiling.
    const limits = readQuotaLimits(process.env, {
      unlimitedNetwork: isUnlimitedNetwork(identity.ip.canonical),
    });
    const ipHash = hashIp(identity.ip.canonical, readIpHashSecret());
    const db = getDb();
    const counters = await readQuotaCounters(db, ipHash, utcDayKey());

    return json(
      {
        quota: buildQuotaSnapshot(limits, counters.userCount, new Date(), counters.globalCount),
        provider: (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER).trim().toLowerCase(),
      },
      200,
      request,
    );
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "quota_unavailable";
    const status = err instanceof ApiError ? err.status : 503;
    console.error(`[quota] unavailable code=${code}`);
    return errorResponse(code, status, USER_MESSAGES[code], request);
  }
}

export default { fetch: route };
