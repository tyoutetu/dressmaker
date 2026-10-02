import { findNpc } from "../lib/npcs";
import { ApiError, USER_MESSAGES } from "../lib/errors";
import { corsHeaders, errorResponse, isOriginAllowed, json } from "../lib/env";
import { getDb, insertGeneration, reserveQuota } from "../lib/db";
import { readBoundedFormData, requestBodyLimitBytes } from "../lib/body";
import { hashIp, resolveClientIp } from "../lib/ip";
import {
  isLocalQuotaMode,
  isVercelRuntime,
  readIpHashSecret,
  readPositiveInt,
  readQuotaLimits,
  type QuotaLimits,
} from "../lib/config";
import { buildQuotaSnapshot, quotaVariantFor, utcDayKey, type QuotaSnapshot } from "../lib/quota";
import { loadNpcReference } from "../lib/npcAssets";
import { DEFAULT_MAX_OUTPUT_BYTES } from "../lib/output";
import { buildPrompt } from "../lib/prompt";
import { asProviderError, getProvider } from "../lib/provider";
import { readMaxUploadBytes, validateImage } from "../lib/validation";

/**
 * POST /api/generate  (multipart/form-data)
 *   npc_id, image, client_id?, utm_source?, utm_campaign?
 *
 * Order of operations is a cost contract:
 *   1. parse + validate everything (bad input, unknown customer, unusable image,
 *      missing config, unusable client identity) — nothing is charged;
 *   2. atomically reserve the per-network AND global daily counters;
 *   3. only then call the paid provider — and never refund that attempt, so a
 *      retry can never quietly buy a second paid call.
 *
 * `client_id` is a browser analytics id only. Quota identity is the HMAC hash of
 * the trusted client IP; the raw address is never stored or logged.
 */

export async function route(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", 405, USER_MESSAGES.method_not_allowed, request);
  }
  if (!isOriginAllowed(origin)) {
    return errorResponse("forbidden_origin", 403, USER_MESSAGES.forbidden_origin, request);
  }

  const startedAt = Date.now();
  let clientId = "";
  let npcId = "";
  let source: string | undefined;
  let campaign: string | undefined;
  let limits: QuotaLimits | null = null;
  let quota: QuotaSnapshot | null = null;

  try {
    // Bound the body before any of it is buffered: an oversized multipart
    // request is refused up front instead of being pulled into memory.
    const form = await readBoundedFormData(
      request,
      requestBodyLimitBytes(readMaxUploadBytes()),
    );

    clientId = String(form.get("client_id") ?? "").trim().slice(0, 64);
    npcId = String(form.get("npc_id") ?? "").trim().slice(0, 64);
    source = String(form.get("utm_source") ?? "").trim().slice(0, 64) || undefined;
    campaign = String(form.get("utm_campaign") ?? "").trim().slice(0, 64) || undefined;
    const image = form.get("image");

    if (!npcId || !(image instanceof File)) {
      throw new ApiError("bad_request", 400, "npc_id and image are required.");
    }

    const npc = findNpc(npcId);
    if (!npc) throw new ApiError("invalid_npc", 400, `Customer "${npcId}" is not available.`);

    // ---- everything below is still free: no counters are touched yet ----
    const identity = resolveClientIp(request.headers, {
      isVercel: isVercelRuntime(),
      localMode: isLocalQuotaMode(),
    });
    if (!identity.ok) {
      throw new ApiError(
        "service_unavailable",
        503,
        `Trusted client identity unavailable (${identity.reason}).`,
      );
    }
    const ipHash = hashIp(identity.ip.canonical, readIpHashSecret());

    limits = readQuotaLimits();
    // Config and validation both run before the reservation: a misconfigured
    // deployment or an unusable upload costs nothing.
    const provider = getProvider();
    const [validated, npcReference] = await Promise.all([
      validateImage(image),
      loadNpcReference(npc.referenceImage),
    ]);

    const db = getDb();
    const usageDate = utcDayKey();
    let reservation;
    try {
      reservation = await reserveQuota(db, ipHash, limits, usageDate);
    } catch (err) {
      // A quota we cannot read is a quota we cannot honour: fail closed and
      // charge nothing rather than letting the request through unmetered.
      throw new ApiError(
        "quota_unavailable",
        503,
        `Quota service unavailable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    quota = buildQuotaSnapshot(limits, reservation.userCount, new Date(), reservation.globalCount);

    if (!reservation.allowed) {
      return errorResponse("limit_reached", 429, USER_MESSAGES.limit_reached, request, {
        variant: quotaVariantFor(reservation.reason),
        counted: false,
        quota,
      });
    }

    // From here on the attempt is reserved and paid for: no refunds, ever.
    const timeoutMs = readPositiveInt(process.env, "GENERATION_TIMEOUT_MS", 240_000);
    let image_png: Buffer;
    try {
      const result = await provider.generate({
        npcReference,
        dressScreenshot: { data: validated.buffer, mime: validated.mime },
        prompt: buildPrompt(npc),
        signal: AbortSignal.timeout(timeoutMs),
        maxOutputBytes: readPositiveInt(process.env, "MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES),
      });
      image_png = result.image;
      const generationId = await insertGeneration(db, {
        clientId,
        ipHash,
        npcId,
        source,
        campaign,
        status: "success",
        provider: provider.id,
        model: provider.model,
        latencyMs: result.latencyMs,
        estimatedCost: result.estimatedCost,
        counted: true,
      });

      return json(
        {
          generation_id: generationId,
          image: `data:image/png;base64,${image_png.toString("base64")}`,
          quota,
          provider: provider.id,
          mock: false,
        },
        200,
        request,
      );
    } catch (err) {
      const apiErr = asProviderError(err);
      await insertGeneration(db, {
        clientId,
        ipHash,
        npcId,
        source,
        campaign,
        status: "failed",
        provider: provider.id,
        model: provider.model,
        latencyMs: Date.now() - startedAt,
        errorType: apiErr.code,
        counted: true,
      });
      console.error(
        `[generate] provider failed code=${apiErr.code} npc=${npcId} provider=${provider.id} request=${Date.now() - startedAt}ms`,
      );
      return errorResponse(apiErr.code, apiErr.status, USER_MESSAGES[apiErr.code], request, {
        counted: true,
        quota,
      });
    }
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "unknown";
    const status = err instanceof ApiError ? err.status : 500;
    console.error(`[generate] failed code=${code} npc=${npcId || "?"}`);
    return errorResponse(code, status, USER_MESSAGES[code], request, {
      counted: false,
      ...(quota ? { quota } : {}),
    });
  }
}

export default { fetch: route };
