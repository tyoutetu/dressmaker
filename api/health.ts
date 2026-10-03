import { corsHeaders, json, isOriginAllowed } from "../lib/env.js";
import { getDb } from "../lib/db.js";
import { isLocalQuotaMode, isVercelRuntime, readQuotaLimits } from "../lib/config.js";
import { DEFAULT_PROVIDER, providerConfigured } from "../lib/provider.js";

/**
 * GET /api/health — deployment smoke check.
 *
 * Booleans only: no configuration values, no secrets, no key names with values,
 * and never a raw client IP. Useful for "did I wire the env vars up?" without
 * leaking anything.
 */
export async function route(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
  }
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, request);
  }
  if (!isOriginAllowed(request.headers.get("origin"))) {
    return json({ error: "forbidden_origin" }, 403, request);
  }

  const provider = (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER).trim().toLowerCase();
  const providerOk = providerConfigured(provider);

  const secretConfigured =
    (process.env.IP_HASH_SECRET ?? "").trim().length >= 16 ||
    (isLocalQuotaMode() && !isVercelRuntime(process.env));

  let limitsOk = false;
  let killSwitchEngaged = false;
  try {
    const limits = readQuotaLimits();
    limitsOk = true;
    killSwitchEngaged = limits.userLimit <= 0 || limits.globalLimit <= 0;
  } catch {
    limitsOk = false;
  }

  let dbOk = false;
  try {
    const db = getDb();
    await db`select 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const quotaConfigured = secretConfigured && limitsOk && dbOk;
  return json(
    {
      ok: providerOk && quotaConfigured,
      provider,
      providerConfigured: providerOk,
      db: dbOk,
      quotaConfigured,
      secretConfigured,
      limitsConfigured: limitsOk,
      paidGenerationDisabled: killSwitchEngaged,
      localQuotaMode: isLocalQuotaMode(),
    },
    200,
    request,
  );
}

export default { fetch: route };
