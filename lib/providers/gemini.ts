import { GoogleGenAI } from "@google/genai";
import { ApiError } from "../errors.js";
import { normalizeOutputImage } from "../output.js";
import { estimatedCost, type GenerateInput, type GenerateResult, type ImageGenerationProvider } from "../provider.js";

/**
 * Gemini image editing (nano-banana family). Passes the NPC reference as the
 * first image and the player's dress screenshot as the second, with the shared
 * prompt explaining which is which.
 */
export class GeminiProvider implements ImageGenerationProvider {
  readonly id = "gemini";
  readonly model: string;
  private client: GoogleGenAI;

  constructor() {
    this.model = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
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
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: npcReference.mime,
                  data: npcReference.data.toString("base64"),
                },
              },
              {
                inlineData: {
                  mimeType: dressScreenshot.mime,
                  data: dressScreenshot.data.toString("base64"),
                },
              },
            ],
          },
        ],
        config: {
          abortSignal: signal,
          // The SDK retries 5 times by default and every attempt is billed.
          httpOptions: { retryOptions: { attempts: 1 } },
        },
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new ApiError("timeout", 504, "Provider request timed out.");
      }
      throw new ApiError("provider_error", 502, err instanceof Error ? err.message : "Gemini call failed.");
    }

    const finishReason = response.candidates?.[0]?.finishReason;
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      if (finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII/i.test(finishReason)) {
        throw new ApiError("safety_rejection", 422, `Gemini refused the image (${finishReason}).`);
      }
      throw new ApiError("provider_error", 502, `Gemini returned no image (finishReason=${finishReason ?? "unknown"}).`);
    }

    // Normalize whatever the model returned into a bounded PNG.
    const image = await normalizeOutputImage(Buffer.from(imagePart.inlineData.data!, "base64"), {
      maxBytes: maxOutputBytes,
    });

    return {
      image,
      latencyMs: Date.now() - startedAt,
      providerRequestId: response.responseId,
      estimatedCost: estimatedCost(this.id),
    };
  }
}
