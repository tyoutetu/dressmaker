/**
 * LOCAL MOCK API — for reviewing the interface without keys, a database or a
 * single paid call. It is NOT deployed and never renders AI output: every
 * preview it returns is a drawn placeholder containing the words
 * "LOCAL MOCK PREVIEW", and every response carries `mock: true`, which the
 * frontend shows as a banner above the result.
 *
 * It implements the same contract as the real endpoints — the same routes, the
 * same per-network/per-UTC-day quota (3 by default), the same reset instant and
 * the same error shapes — so what you click through here is what the deployed
 * tool does. The contract is asserted in tests/mock-contract.test.ts.
 *
 *   cd api && npm run mock          # http://localhost:8787
 *   cd web && VITE_API_BASE=http://localhost:8787 npm run dev
 *
 * Optional env:
 *   MOCK_PORT=8787              port to listen on
 *   MOCK_USER_DAILY_LIMIT=3     per-network attempts per UTC day
 *   MOCK_GLOBAL_DAILY_LIMIT=100 global attempts per UTC day
 *   MOCK_FAIL=timeout|provider  make every generation fail (to review the UI)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { findNpc } from "../lib/npcs";
import { buildQuotaSnapshot, utcDayKey } from "../lib/quota";
import { USER_DAILY_GENERATION_LIMIT_MAX } from "../lib/config";

export interface MockLimits {
  userLimit: number;
  globalLimit: number;
}

export interface MockRequest {
  method: string;
  pathname: string;
  /** Parsed multipart body for /api/generate. */
  form?: FormData | null;
  /** Parsed JSON body for /api/feedback. */
  json?: unknown;
}

export interface MockResult {
  status: number;
  body: Record<string, unknown>;
}

export interface MockApiOptions {
  userLimit?: number;
  globalLimit?: number;
  /** Force every generation to fail: useful for reviewing the error states. */
  failure?: "" | "timeout" | "provider";
}

/**
 * The mock's behaviour, isolated from the socket so it can be tested. State is
 * per instance: one UTC day of counters keyed by "network" (this machine).
 */
export function createMockApi(options: MockApiOptions = {}) {
  const userLimit = options.userLimit ?? 3;
  const globalLimit = options.globalLimit ?? 100;
  if (userLimit > USER_DAILY_GENERATION_LIMIT_MAX) {
    throw new Error(
      `MOCK_USER_DAILY_LIMIT must be between 0 and ${USER_DAILY_GENERATION_LIMIT_MAX}; got ${userLimit}.`,
    );
  }
  const failure = options.failure ?? "";
  const counters = new Map<string, number>();
  const day = utcDayKey();
  const network = "local-mock-network";
  const key = `${day}|${network}`;

  const used = () => counters.get(key) ?? 0;
  // The mock has one network, so its per-network counter is also the global one.
  const snapshot = (count: number) => buildQuotaSnapshot({ userLimit, globalLimit }, count, new Date(), count);

  return {
    day,
    limits: { userLimit, globalLimit } satisfies MockLimits,

    async fetch(request: MockRequest): Promise<MockResult> {
      if (request.method === "GET" && request.pathname === "/api/health") {
        return {
          status: 200,
          body: {
            ok: true,
            provider: "mock",
            providerConfigured: true,
            db: true,
            quotaConfigured: true,
            mock: true,
          },
        };
      }

      if (request.method === "GET" && request.pathname === "/api/quota") {
        return { status: 200, body: { quota: snapshot(used()), provider: "mock", mock: true } };
      }

      if (request.method === "POST" && request.pathname === "/api/feedback") {
        const payload = (request.json ?? {}) as { rating?: string; generation_id?: string };
        if (!payload.generation_id || !["yes", "kind_of", "no"].includes(payload.rating ?? "")) {
          return { status: 400, body: { error: "bad_request", message: "Invalid feedback payload." } };
        }
        return { status: 200, body: { ok: true } };
      }

      if (request.method === "POST" && request.pathname === "/api/generate") {
        const npcId = String(request.form?.get("npc_id") ?? "");
        const image = request.form?.get("image");
        const npc = findNpc(npcId);
        if (!npc || !(image instanceof File)) {
          return {
            status: 400,
            body: {
              error: "bad_request",
              message: "npc_id and image are required.",
              details: { counted: false },
            },
          };
        }

        const already = used();
        if (already >= userLimit || already >= globalLimit) {
          return {
            status: 429,
            body: {
              error: "limit_reached",
              message: "Today's preview limit has been reached. It refreshes at 00:00 UTC.",
              details: {
                variant: already >= globalLimit ? "global" : "network",
                counted: false,
                quota: snapshot(already),
              },
            },
          };
        }

        counters.set(key, already + 1);
        const quota = snapshot(already + 1);

        if (failure) {
          return {
            status: failure === "timeout" ? 504 : 502,
            body: {
              error: failure === "timeout" ? "timeout" : "provider_error",
              message:
                failure === "timeout"
                  ? "The AI service did not answer in time, so the preview was stopped."
                  : "The AI service could not finish this preview.",
              details: { counted: true, quota },
            },
          };
        }

        const image_png = await mockPreview(npc.name, npc.name[0]);
        return {
          status: 200,
          body: {
            generation_id: crypto.randomUUID(),
            image: `data:image/png;base64,${image_png.toString("base64")}`,
            quota,
            provider: "mock",
            mock: true,
          },
        };
      }

      return { status: 404, body: { error: "not_found", message: "Unknown endpoint." } };
    },
  };
}

/** Placeholder artwork. Deliberately obvious so it can never pass as AI output. */
export function mockPreview(npcName: string, initial: string): Promise<Buffer> {
  const dots = [
    [430, 980, 14], [500, 1052, 11], [568, 962, 13], [472, 862, 10],
    [560, 872, 11], [622, 1032, 12], [392, 1062, 11], [520, 930, 12],
  ]
    .map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536">
  <rect width="1024" height="1536" fill="#faf5ee"/>
  <rect x="40" y="40" width="944" height="1456" rx="28" fill="none" stroke="#d9b8a8" stroke-width="4" stroke-dasharray="16 12"/>
  <rect x="252" y="96" width="520" height="56" rx="28" fill="#fbeef0" stroke="#c2586e" stroke-width="3"/>
  <text x="512" y="134" text-anchor="middle" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="6" fill="#a84459">LOCAL MOCK PREVIEW</text>
  <circle cx="512" cy="360" r="130" fill="#ffffff" stroke="#eadfd0" stroke-width="4"/>
  <text x="512" y="412" text-anchor="middle" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="124" font-weight="700" fill="#c2586e">${initial}</text>
  <path d="M512 545 Q556 528 556 488" fill="none" stroke="#8a7b6c" stroke-width="8" stroke-linecap="round"/>
  <circle cx="424" cy="616" r="36" fill="#c2586e"/>
  <circle cx="600" cy="616" r="36" fill="#c2586e"/>
  <path d="M432 600 Q512 556 592 600 L608 736 Q512 776 416 736 Z" fill="#c2586e"/>
  <clipPath id="skirt"><path d="M428 748 L596 748 L700 1130 Q512 1192 324 1130 Z"/></clipPath>
  <path d="M428 748 L596 748 L700 1130 Q512 1192 324 1130 Z" fill="#c2586e"/>
  <g clip-path="url(#skirt)" fill="#ffffff" opacity="0.35">${dots}</g>
  <rect x="414" y="722" width="196" height="40" rx="20" fill="#a84459"/>
  <path d="M324 1130 Q512 1192 700 1130" fill="none" stroke="#a84459" stroke-width="10"/>
  <text x="512" y="1296" text-anchor="middle" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="46" font-weight="700" fill="#3d3229">${npcName} is wearing your dress</text>
  <text x="512" y="1354" text-anchor="middle" font-family="Avenir Next, Helvetica, Arial, sans-serif" font-size="27" fill="#8a7b6c">Placeholder from the local mock — not AI output</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Thin HTTP shell around the behaviour above (not covered by the sandboxed
// test run, which cannot bind a port).
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function send(res: ServerResponse, req: IncomingMessage, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req.headers.origin ?? null),
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function toFormData(req: IncomingMessage, raw: Buffer): Promise<FormData> {
  const request = new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] ?? "" },
    body: new Uint8Array(raw),
  });
  return request.formData();
}

export function startMockServer(port: number, options: MockApiOptions | undefined, env = process.env) {
  const api = createMockApi({
    userLimit: Number(env.MOCK_USER_DAILY_LIMIT ?? options?.userLimit ?? 3),
    globalLimit: Number(env.MOCK_GLOBAL_DAILY_LIMIT ?? options?.globalLimit ?? 100),
    failure: (env.MOCK_FAIL ?? options?.failure ?? "") as "" | "timeout" | "provider",
  });

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? null;
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    try {
      const raw = req.method === "POST" ? await readBody(req) : Buffer.alloc(0);
      const result = await api.fetch({
        method: req.method ?? "GET",
        pathname: url.pathname,
        form:
          url.pathname === "/api/generate"
            ? await toFormData(req, raw).catch(() => null)
            : undefined,
        json:
          url.pathname === "/api/feedback"
            ? JSON.parse(raw.toString("utf8") || "{}")
            : undefined,
      });
      if (result.status === 200 && url.pathname === "/api/generate") {
        console.log(`[mock] generate served from placeholder art (no model was called)`);
      }
      send(res, req, result.status, result.body);
    } catch (err) {
      console.error("[mock] error", err);
      send(res, req, 500, { error: "unknown", message: "Mock server error." });
    }
  });

  return { server, api };
}

const invokedPath = process.argv[1] ?? "";
const isDirectRun =
  /mock-server\.(ts|js|mts)$/.test(invokedPath) ||
  (invokedPath !== "" && import.meta.url === pathToFileURL(invokedPath).href);

if (isDirectRun) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  const { server } = startMockServer(port, undefined);
  server.listen(port, () => {
    console.log(`[mock] LOCAL MOCK listening on http://localhost:${port} (no model is called)`);
    console.log(
      `[mock] quota: ${process.env.MOCK_USER_DAILY_LIMIT ?? 3} per network per UTC day, global ${process.env.MOCK_GLOBAL_DAILY_LIMIT ?? 100}`,
    );
    if (process.env.MOCK_FAIL) console.log(`[mock] MOCK_FAIL=${process.env.MOCK_FAIL}: generations fail on purpose`);
    console.log(`[mock] frontend: cd web && VITE_API_BASE=http://localhost:${port} npm run dev`);
  });
}
