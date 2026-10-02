import { ApiError } from "./errors";
import { readNonNegativeDecimal } from "./config";
import { GeminiProvider } from "./providers/gemini";
import { OpenAIProvider } from "./providers/openai";
import { QwenProvider } from "./providers/qwen";

/** An image handed to a model, always with an explicit MIME type. */
export interface ImageInput {
  data: Buffer;
  mime: string;
}

export interface GenerateInput {
  /** Reference art of the customer (identity to preserve), PNG. */
  npcReference: ImageInput;
  /** Player's dress screenshot (the design to migrate), JPEG. */
  dressScreenshot: ImageInput;
  prompt: string;
  signal?: AbortSignal;
  /** Upper bound for the returned PNG so the HTTP response stays small. */
  maxOutputBytes?: number;
}

export interface GenerateResult {
  /** PNG bytes, ready to be base64-encoded for the client. */
  image: Buffer;
  latencyMs: number;
  providerRequestId?: string;
  estimatedCost?: number;
}

export interface ImageGenerationProvider {
  readonly id: string;
  readonly model: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export const DEFAULT_PROVIDER = "qwen";

let testProvider: ImageGenerationProvider | null = null;

/** Test seam: lets the suite exercise handlers without calling a paid API. */
export function setProviderForTests(provider: ImageGenerationProvider | null): void {
  testProvider = provider;
}

/**
 * Selected by AI_PROVIDER ("qwen" | "gemini" | "openai"). Business code only
 * depends on the interface, so providers stay swappable. A missing key throws
 * before any quota is reserved, so a misconfigured deployment costs nothing.
 */
export function getProvider(): ImageGenerationProvider {
  if (testProvider) return testProvider;
  const kind = (process.env.AI_PROVIDER ?? DEFAULT_PROVIDER).trim().toLowerCase();
  switch (kind) {
    case "qwen": {
      if (!process.env.DASHSCOPE_API_KEY) {
        throw new ApiError("service_unavailable", 503, "DASHSCOPE_API_KEY is not set.");
      }
      return new QwenProvider();
    }
    case "gemini": {
      if (!process.env.GEMINI_API_KEY) {
        throw new ApiError("service_unavailable", 503, "GEMINI_API_KEY is not set.");
      }
      return new GeminiProvider();
    }
    case "openai": {
      if (!process.env.OPENAI_API_KEY) {
        throw new ApiError("service_unavailable", 503, "OPENAI_API_KEY is not set.");
      }
      return new OpenAIProvider();
    }
    default:
      throw new ApiError("service_unavailable", 503, `Unknown AI_PROVIDER "${kind}".`);
  }
}

export function providerConfigured(kind: string): boolean {
  switch (kind.trim().toLowerCase()) {
    case "qwen":
      return Boolean(process.env.DASHSCOPE_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    default:
      return false;
  }
}

/**
 * Operator-provided, clearly-labelled cost estimate used for the ops breakdown
 * only. It is never shown to visitors as a price and never affects the quota
 * decision. When `ESTIMATED_COST_<PROVIDER>_PER_IMAGE_USD` is unset we return
 * `undefined` and record NULL: this code deliberately ships no invented provider
 * price, and a decimal such as `0.03` is preserved exactly.
 */
export function estimatedCost(providerId: string): number | undefined {
  return readNonNegativeDecimal(
    process.env,
    `ESTIMATED_COST_${providerId.toUpperCase()}_PER_IMAGE_USD`,
  );
}

/** Wrap an unknown provider failure into an ApiError with a safe code. */
export function asProviderError(err: unknown, fallback: "provider_error" | "rate_limit" = "provider_error"): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ApiError("timeout", 504, "Provider request timed out.");
  }
  return new ApiError(fallback, 502, err instanceof Error ? err.message : "Provider failed.");
}
