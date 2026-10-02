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

/** Returns true if the given request origin may call this API. */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // non-browser clients (curl, spike script)
  if (process.env.ALLOW_ALL_ORIGINS === "true") return true;
  const allowed = strEnv("ALLOWED_ORIGINS", "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return allowed.includes(origin) || LOCAL_ORIGINS.includes(origin);
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
