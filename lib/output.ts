import sharp from "sharp";
import { ApiError } from "./errors.js";

/**
 * Provider output normalization.
 *
 * A preview is only accepted if it decodes as a real, bounded image; anything
 * else is re-encoded as PNG. The byte ceiling keeps the JSON response (which
 * carries the PNG as base64) comfortably inside Vercel's 4.5 MB response limit.
 *
 * The dimension ceiling is the *long edge*, so both axes are constrained:
 * a portrait result is scaled down on its height even though its width is
 * already small.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 2_600_000;
export const DEFAULT_OUTPUT_DIMENSION = 1024;

export interface OutputOptions {
  maxBytes?: number;
  maxDimension?: number;
}

export async function normalizeOutputImage(
  input: Buffer,
  options: OutputOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxDimension = options.maxDimension ?? DEFAULT_OUTPUT_DIMENSION;

  let pipeline: sharp.Sharp;
  let meta: sharp.Metadata;
  try {
    pipeline = sharp(input, { limitInputPixels: 40_000_000, failOn: "error" });
    meta = await pipeline.metadata();
  } catch {
    throw new ApiError("provider_error", 502, "The AI returned an unreadable image.");
  }
  if (!meta.width || !meta.height) {
    throw new ApiError("provider_error", 502, "The AI returned an empty image.");
  }

  let dimension = maxDimension;
  let encoded = await encodePng(pipeline, dimension, false);
  if (encoded.length <= maxBytes) return encoded;

  encoded = await encodePng(pipeline, dimension, true);
  if (encoded.length <= maxBytes) return encoded;

  // Still too large: step the long edge down until the payload fits. Never
  // upscale, and never crop — the whole preview stays visible.
  const floor = Math.min(512, maxDimension);
  for (const scale of [0.85, 0.72, 0.6, 0.5]) {
    dimension = Math.max(floor, Math.round(dimension * scale));
    encoded = await encodePng(pipeline, dimension, true);
    if (encoded.length <= maxBytes) return encoded;
  }

  throw new ApiError("provider_error", 502, "The AI preview was too large to return.");
}

async function encodePng(pipeline: sharp.Sharp, dimension: number, palette: boolean): Promise<Buffer> {
  return pipeline
    .clone()
    .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
    .png(palette ? { compressionLevel: 9, palette: true, effort: 10 } : { compressionLevel: 9 })
    .toBuffer();
}
