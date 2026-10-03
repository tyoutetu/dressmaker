import { ApiError, USER_MESSAGES } from "../lib/errors.js";
import { corsHeaders, errorResponse, isOriginAllowed, json } from "../lib/env.js";
import { getDb } from "../lib/db.js";
import { readBoundedJson } from "../lib/body.js";

const RATINGS = new Set(["yes", "kind_of", "no"]);
const MAX_TEXT = 500;
const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /api/feedback  (application/json)
 *   { generation_id, rating: "yes"|"kind_of"|"no", feedback_text?, client_id?, utm_source? }
 *
 * One row per generation (upsert), so a visitor can change their mind. Free text
 * is optional, capped at 500 characters, stored only here and never sent to GA4.
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

  try {
    const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
    const body = parsed as Record<string, unknown> | null;
    if (!body) throw new ApiError("bad_request", 400, "Expected a JSON body.");

    const generationId = String(body.generation_id ?? "").trim();
    const rating = String(body.rating ?? "").trim();
    const source = String(body.utm_source ?? "").trim().slice(0, 64) || null;
    const text = sanitizeText(String(body.feedback_text ?? ""));

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generationId)) {
      throw new ApiError("bad_request", 400, "generation_id must be a UUID.");
    }
    if (!RATINGS.has(rating)) {
      throw new ApiError("bad_request", 400, 'rating must be "yes", "kind_of" or "no".');
    }

    const db = getDb();
    try {
      await db`
        insert into feedback (generation_id, rating, feedback_text, source)
        values (${generationId}, ${rating}, ${text}, ${source})
        on conflict (generation_id) do update
          set rating = excluded.rating,
              feedback_text = coalesce(excluded.feedback_text, feedback.feedback_text)
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid input syntax for type uuid|violates foreign key/i.test(msg)) {
        throw new ApiError("not_found", 404, "That generation could not be found.");
      }
      throw err;
    }

    return json({ ok: true }, 200, request);
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "unknown";
    const status = err instanceof ApiError ? err.status : 500;
    console.error("[feedback] failed", err instanceof Error ? err.message : err);
    return errorResponse(code, status, USER_MESSAGES[code], request);
  }
}

export default { fetch: route };

function sanitizeText(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return cleaned || null;
}
