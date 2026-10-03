import OpenAI, { APIError } from "openai";
import { ApiError } from "../errors";
import { normalizeOutputImage } from "../output";
import { estimatedCost, type GenerateInput, type GenerateResult, type ImageGenerationProvider } from "../provider";

/**
 * OpenAI image editing (gpt-image-1). The first image is the NPC reference
 * (the base to edit), the second is the player's dress screenshot.
 */
export class OpenAIProvider implements ImageGenerationProvider {
  readonly id = "openai";
  readonly model: string;
  private client: OpenAI;

  constructor() {
    this.model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1";
    // maxRetries: 0 — every attempt is billed, so the SDK must never retry a
    // generation on its own. Retries are the visitor's explicit choice.
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, maxRetries: 0 });
  }

  async generate({
    npcReference,
    dressScreenshot,
    prompt,
    signal,
    maxOutputBytes,
  }: GenerateInput): Promise<GenerateResult> {
    const startedAt = Date.now();
    let response;
    try {
      response = await this.client.images.edit(
        {
          model: this.model,
          image: [
            new File([new Uint8Array(npcReference.data)], "npc-reference.png", {
              type: npcReference.mime,
            }),
            new File([new Uint8Array(dressScreenshot.data)], "dress-screenshot.jpg", {
              type: dressScreenshot.mime,
            }),
          ],
          prompt,
          size: "1024x1536",
          quality: (process.env.OPENAI_IMAGE_QUALITY as "low" | "medium" | "high") ?? "medium",
          n: 1,
        },
        // Belt and braces: no SDK-level retry on a billed generation, even if
        // the client default ever changes.
        { signal, maxRetries: 0 },
      );
    } catch (err) {
      if (err instanceof APIError) {
        if (err.status === 429) throw new ApiError("rate_limit", 429, "OpenAI rate limit hit.");
        const code = (err as { code?: string; error?: { code?: string } }).code
          ?? (err as { error?: { code?: string } }).error?.code;
        if (typeof code === "string" && /content_policy|moderation/i.test(code)) {
          throw new ApiError("safety_rejection", 422, `OpenAI refused the image (${code}).`);
        }
        throw new ApiError("provider_error", 502, `OpenAI error: ${err.message}`);
      }
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new ApiError("timeout", 504, "Provider request timed out.");
      }
      throw new ApiError("provider_error", 502, err instanceof Error ? err.message : "OpenAI call failed.");
    }

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new ApiError("provider_error", 502, "OpenAI returned no image.");
    }

    const image = await normalizeOutputImage(Buffer.from(b64, "base64"), {
      maxBytes: maxOutputBytes,
    });

    return {
      image,
      latencyMs: Date.now() - startedAt,
      // The Images API response carries no request id.
      estimatedCost: estimatedCost(this.id),
    };
  }
}
