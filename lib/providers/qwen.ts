import { ApiError } from "../errors.js";
import { normalizeOutputImage } from "../output.js";
import {
  estimatedCost,
  type GenerateInput,
  type GenerateResult,
  type ImageGenerationProvider,
  type ImageInput,
} from "../provider.js";

/**
 * Qwen Image (DashScope) adapter.
 *
 * Uses the OpenAI-compatible JSON endpoint:
 *   POST {QWEN_BASE_URL}/compatible-mode/v1/images/generations
 * with `image: [reference, dress]` as data URLs, `n: 1` and a fixed size.
 * This is NOT the standard OpenAI multipart image-edit call.
 *
 * The endpoint, model and key are server configuration only; nothing a client
 * sends can override them. The returned image URL is downloaded without an
 * Authorization header and is re-validated as an image before it is returned.
 */

/**
 * Default platform: 千问AI平台. Set `QWEN_BASE_URL=https://dashscope.aliyuncs.com`
 * to run against 阿里云百炼 instead — both are on the endpoint allowlist below.
 * The default is deliberately a single explicit host rather than "whichever
 * answers": an unset variable should not quietly decide which account is billed.
 */
export const DEFAULT_QWEN_BASE_URL = "https://maas.qianwenaiapi.com";
export const DEFAULT_QWEN_MODEL = "qwen-image-3.0";
export const QWEN_IMAGE_PATH = "/compatible-mode/v1/images/generations";
export const QWEN_IMAGE_SIZE = "1024x1024";

/**
 * Both of these are sent explicitly on every request because the *service*
 * defaults them to `true`, which is wrong for this product:
 *
 *  - `prompt_extend: true` lets the model rewrite the prompt. Ours is almost
 *    entirely negative constraints ("do not redesign the dress", "add no
 *    decoration that is not visible"), and a rewriter can soften exactly the
 *    rules that keep the output faithful to the player's screenshot.
 *  - `enable_thinking: true` "increases generation time", and the attempt is
 *    reserved before the provider call and never refunded, so a slow request
 *    that exceeds GENERATION_TIMEOUT_MS burns a visitor's daily allowance.
 *
 * Omitting the fields is NOT the same as disabling them: the platform default
 * would apply. Set QWEN_PROMPT_EXTEND=true / QWEN_ENABLE_THINKING=true to opt
 * back in (thinking also requires prompt extend; see the constructor).
 */
export const DEFAULT_PROMPT_EXTEND = false;
export const DEFAULT_ENABLE_THINKING = false;

/**
 * Endpoint hosts this deployment may talk to. Both are Qwen-operated image
 * platforms that serve the same OpenAI-compatible contract, so switching between
 * them is a `QWEN_BASE_URL` change and nothing else:
 *
 *   maas.qianwenaiapi.com   千问AI平台 (QwenCloud) — API keys start with `sk-ws-`
 *   *.aliyuncs.com          阿里云百炼 / Model Studio — API keys start with `sk-`
 *
 * The keys belong to separate accounts and are NOT interchangeable, so pointing
 * at the wrong host fails with a credential error rather than silently billing
 * someone else. This list is an allowlist, not a convenience: it is what stops
 * `QWEN_BASE_URL` from being aimed at an arbitrary server.
 */
const ALLOWED_ENDPOINT_SUFFIXES = [".qianwenaiapi.com", ".aliyuncs.com"];

/**
 * Result images are still served from Aliyun OSS on both platforms — the
 * QwenCloud OpenAI-compatible reference itself returns
 * `https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/...` — so the result
 * allowlist is unchanged.
 */
const ALLOWED_RESULT_SUFFIXES = [".aliyuncs.com", ".aliyun.com", ".alicdn.com"];
export const MAX_RESULT_BYTES = 8_000_000;

export interface QwenProviderOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  promptExtend?: boolean;
  enableThinking?: boolean;
  fetchImpl?: typeof fetch;
  /** Test seam only: permits an http loopback endpoint and loopback result host. */
  allowTestEndpoints?: boolean;
}

export class QwenProvider implements ImageGenerationProvider {
  readonly id = "qwen";
  readonly model: string;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly promptExtend: boolean;
  private readonly enableThinking: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly allowTestEndpoints: boolean;

  constructor(options: QwenProviderOptions = {}) {
    const rawBase = options.baseUrl ?? process.env.QWEN_BASE_URL ?? DEFAULT_QWEN_BASE_URL;
    this.allowTestEndpoints = options.allowTestEndpoints === true;
    this.endpoint = resolveImageEndpoint(rawBase, this.allowTestEndpoints);
    this.model = (options.model ?? process.env.QWEN_IMAGE_MODEL ?? DEFAULT_QWEN_MODEL).trim();
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
    this.promptExtend =
      options.promptExtend ?? readBooleanFlag(process.env.QWEN_PROMPT_EXTEND, DEFAULT_PROMPT_EXTEND);
    this.enableThinking =
      options.enableThinking ?? readBooleanFlag(process.env.QWEN_ENABLE_THINKING, DEFAULT_ENABLE_THINKING);
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.model) {
      throw new ApiError("service_unavailable", 503, "QWEN_IMAGE_MODEL is empty.");
    }
    // Thinking mode only takes effect while prompt extend is on, so asking for
    // it with rewriting disabled is a contradiction: the platform documents
    // "enable_thinking ... 仅在 prompt_extend=true 时生效" ("only takes effect
    // when"), i.e. it would be silently ignored rather than honoured. Silently
    // ignoring an operator's explicit setting is the same class of surprise this
    // file exists to prevent, so refuse the combination instead. This runs before
    // the quota is reserved, so a misconfigured deployment costs nothing.
    if (this.enableThinking && !this.promptExtend) {
      throw new ApiError(
        "service_unavailable",
        503,
        "QWEN_ENABLE_THINKING=true needs QWEN_PROMPT_EXTEND=true: thinking mode is ignored while prompt rewriting is off.",
      );
    }
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const startedAt = Date.now();
    const body = buildQwenImageBody({
      model: this.model,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      npcReference: input.npcReference,
      dressScreenshot: input.dressScreenshot,
      promptExtend: this.promptExtend,
      enableThinking: this.enableThinking,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      throw mapFetchFailure(err, "Qwen image request failed");
    }

    const requestId = response.headers.get("x-request-id") ?? undefined;
    const payload = await readTextBounded(response, 4_000_000);
    if (!response.ok) {
      throw mapQwenError(response.status, payload, requestId);
    }

    const parsed = parseQwenResponse(payload);
    if (!parsed.ok) {
      throw new ApiError("provider_error", 502, `Qwen returned no image (${parsed.reason}).`);
    }

    const raw = parsed.url
      ? await this.downloadImage(parsed.url, input.signal)
      : Buffer.from(parsed.b64 ?? "", "base64");

    const image = await normalizeOutputImage(raw, { maxBytes: input.maxOutputBytes });
    return {
      image,
      latencyMs: Date.now() - startedAt,
      providerRequestId: requestId,
      estimatedCost: estimatedCost(this.id),
    };
  }

  private async downloadImage(rawUrl: string, signal?: AbortSignal): Promise<Buffer> {
    let current = rawUrl;
    for (let hop = 0; hop < 3; hop++) {
      const url = assertResultUrl(current, this.allowTestEndpoints);
      let response: Response;
      try {
        // No Authorization header: the result lives on a different host.
        response = await this.fetchImpl(url.toString(), { signal, redirect: "manual" });
      } catch (err) {
        throw mapFetchFailure(err, "Downloading the Qwen result failed");
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ApiError("provider_error", 502, "Qwen returned an image redirect without a target.");
        }
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        throw new ApiError("provider_error", 502, `Qwen image download failed (${response.status}).`);
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType && !contentType.startsWith("image/")) {
        throw new ApiError("provider_error", 502, "Qwen returned a non-image response.");
      }
      return readBytesBounded(response, MAX_RESULT_BYTES);
    }
    throw new ApiError("provider_error", 502, "Qwen image URL redirected too many times.");
  }
}

export interface QwenBodyParams {
  model: string;
  prompt: string;
  negativePrompt?: string;
  npcReference: ImageInput;
  dressScreenshot: ImageInput;
  promptExtend?: boolean;
  enableThinking?: boolean;
}

/**
 * Pure builder so the request contract can be asserted in tests.
 *
 * `prompt_extend` and `enable_thinking` are always written out: the platform
 * turns both on when they are absent, and this product wants them off.
 * `negative_prompt` is only sent when there is one to send.
 */
export function buildQwenImageBody(params: QwenBodyParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    image: [toDataUrl(params.npcReference), toDataUrl(params.dressScreenshot)],
    n: 1,
    size: QWEN_IMAGE_SIZE,
    prompt_extend: params.promptExtend ?? DEFAULT_PROMPT_EXTEND,
    enable_thinking: params.enableThinking ?? DEFAULT_ENABLE_THINKING,
  };
  const negative = (params.negativePrompt ?? "").trim();
  if (negative) body.negative_prompt = negative;
  return body;
}

export function toDataUrl(image: ImageInput): string {
  return `data:${image.mime};base64,${image.data.toString("base64")}`;
}

export type QwenParseResult =
  | { ok: true; url?: string; b64?: string }
  | { ok: false; reason: string; safety: boolean };

export function parseQwenResponse(payload: string): QwenParseResult {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "invalid JSON", safety: false };
  }
  // JSON null, arrays and primitives are not a provider envelope: report a clean
  // failure instead of throwing on a property access.
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, reason: "unexpected JSON shape", safety: false };
  }
  const record = json as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  if (code) {
    const message = typeof record.message === "string" ? record.message : "";
    return { ok: false, reason: `${code}: ${message}`.trim(), safety: isSafetyCode(`${code} ${message}`) };
  }
  const data = Array.isArray(record.data) ? (record.data as Array<Record<string, unknown>>) : [];
  const first = data[0];
  if (!first) return { ok: false, reason: "empty data array", safety: false };
  const url = typeof first.url === "string" ? first.url : undefined;
  const b64 = typeof first.b64_json === "string" ? first.b64_json : undefined;
  if (!url && !b64) return { ok: false, reason: "no url or b64_json", safety: false };
  return { ok: true, url, b64 };
}

export function resolveImageEndpoint(rawBase: string, allowTestEndpoints = false): URL {
  const base = rawBase.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ApiError("service_unavailable", 503, "QWEN_BASE_URL is not a valid URL.");
  }
  if (url.username || url.password) {
    throw new ApiError("service_unavailable", 503, "QWEN_BASE_URL must not embed credentials.");
  }
  if (url.protocol !== "https:" && !allowTestEndpoints) {
    throw new ApiError("service_unavailable", 503, "QWEN_BASE_URL must use https.");
  }
  if (
    !isLoopbackHost(url.hostname) &&
    !ALLOWED_ENDPOINT_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  ) {
    throw new ApiError(
      "service_unavailable",
      503,
      `QWEN_BASE_URL host must end with ${ALLOWED_ENDPOINT_SUFFIXES.join(" or ")}.`,
    );
  }
  if (isLoopbackHost(url.hostname) && !allowTestEndpoints) {
    throw new ApiError("service_unavailable", 503, "QWEN_BASE_URL must be a public Qwen host.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/compatible-mode/v1")
    ? `${path}/images/generations`
    : `${path}${QWEN_IMAGE_PATH}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function assertResultUrl(rawUrl: string, allowTestEndpoints = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError("provider_error", 502, "Qwen returned an invalid image URL.");
  }
  if (url.username || url.password) {
    throw new ApiError("provider_error", 502, "Qwen image URL contained credentials.");
  }
  if (url.protocol !== "https:" && !(allowTestEndpoints && url.protocol === "http:")) {
    throw new ApiError("provider_error", 502, "Qwen image URL was not https.");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    (allowTestEndpoints && isLoopbackHost(host)) ||
    ALLOWED_RESULT_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new ApiError("provider_error", 502, "Qwen image URL pointed at an unexpected host.");
  }
  return url;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

function isSafetyCode(text: string): boolean {
  return /datainspectionfailed|datainspection|content[_ ]?policy|sensitive|moderation|risk/i.test(text);
}

function mapQwenError(status: number, payload: string, requestId?: string): ApiError {
  const detail = `${status} ${truncate(payload, 400)}${requestId ? ` (request ${requestId})` : ""}`;
  if (status === 429) return new ApiError("rate_limit", 429, `Qwen rate limit: ${detail}`);
  if (status === 401 || status === 403) {
    return new ApiError("service_unavailable", 503, `Qwen rejected the server credentials: ${detail}`);
  }
  if (isSafetyCode(payload)) {
    return new ApiError("safety_rejection", 422, `Qwen refused the image: ${detail}`);
  }
  return new ApiError("provider_error", 502, `Qwen error: ${detail}`);
}

function mapFetchFailure(err: unknown, context: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ApiError("timeout", 504, `${context}: the request was aborted.`);
  }
  return new ApiError("provider_error", 502, `${context}: ${err instanceof Error ? err.message : "unknown error"}`);
}

/**
 * Read an opt-in boolean flag. Unset, empty or unrecognised values return the
 * default, and for these two flags the default is `false` — see
 * DEFAULT_PROMPT_EXTEND for why the platform default of `true` is not used.
 */
function readBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readBytesBounded(response, maxBytes, true);
  return bytes.toString("utf8");
}

async function readBytesBounded(
  response: Response,
  maxBytes: number,
  allowEmpty = false,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError("provider_error", 502, "Qwen response exceeded the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ApiError("provider_error", 502, "Qwen response exceeded the size limit.");
    if (!allowEmpty && buffer.length === 0) throw new ApiError("provider_error", 502, "Qwen returned an empty image.");
    return buffer;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError("provider_error", 502, "Qwen response exceeded the size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks);
  if (!allowEmpty && buffer.length === 0) {
    throw new ApiError("provider_error", 502, "Qwen returned an empty image.");
  }
  return buffer;
}
