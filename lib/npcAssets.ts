import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ApiError } from "./errors.js";
import type { ImageInput } from "./provider.js";

/**
 * Customer reference art lives in `assets/npcs/` at the project root and is
 * bundled into the function through the `includeFiles` entry in vercel.json.
 * It is deliberately outside `api/`: everything under `api/` becomes a public
 * HTTP route, and this art must not be served.
 *
 * The shipped art is WebP; every provider gets a uniform PNG with a correct
 * MIME type instead of a byte buffer the model has to guess at.
 */
export async function loadNpcReference(referencePath: string): Promise<ImageInput> {
  const candidates = [
    // The normal case: a function's cwd is the project root, and the spike and
    // mock scripts run from there too.
    path.resolve(process.cwd(), referencePath),
    // Running from web/ still resolves the bundled art one level up.
    path.resolve(process.cwd(), "..", referencePath),
  ];

  let raw: Buffer | null = null;
  for (const candidate of candidates) {
    try {
      raw = await readFile(candidate);
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!raw) {
    throw new ApiError(
      "service_unavailable",
      503,
      `Customer reference image not found for path "${referencePath}".`,
    );
  }

  try {
    const png = await sharp(raw, { limitInputPixels: 40_000_000 })
      .rotate()
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { data: png, mime: "image/png" };
  } catch {
    throw new ApiError(
      "service_unavailable",
      503,
      `Customer reference image "${referencePath}" could not be decoded.`,
    );
  }
}
