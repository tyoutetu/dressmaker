import type { GenErrorCode } from "./errors";

export function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function strEnv(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw && raw.trim() ? raw.trim() : fallback;
}

const LOCAL_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

/**
 * Origins that are this very deployment.
 *
 * With the site and its functions served by one Vercel project, a browser POST
 * still carries an `Origin` header, and that origin is the deployment's own host.
 * Refusing it would break the arrangement this project is built around, and
 * requiring an operator to list their own domain by hand is a footgun: forget
 * the variable and every generation 403s.
 *
 * Vercel exposes the hostnames as system environment variables, so this covers
 * the production alias and every preview deployment without anyone configuring
 * anything. Allowing your own origin is not a loosening — a browser cannot forge
 * the Origin of a cross-site request.
 */
function ownOrigins(): string[] {
  return [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]
    .map((host) => (host ?? "").trim())
    .filter(Boolean)
    .map((host) => `https://${host}`);
}

/** Returns true if the given request origin may call this API. */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // non-browser clients (curl, spike script)
  if (process.env.ALLOW_ALL_ORIGINS === "true") return true;
  const allowed = strEnv("ALLOWED_ORIGINS", "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return (
    allowed.includes(origin) ||
    LOCAL_ORIGINS.includes(origin) ||
    ownOrigins().includes(origin)
  );
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function json(data: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(req?.headers.get("origin") ?? null),
    },
  });
}

export function errorResponse(
  code: GenErrorCode,
  status: number,
  message: string,
  req: Request,
  details?: Record<string, unknown>,
): Response {
  return json({ error: code, message, ...(details ? { details } : {}) }, status, req);
}
