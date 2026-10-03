import sharp from "sharp";
import { ApiError } from "./errors";
import { numEnv } from "./env";

export type SupportedMime = "image/jpeg" | "image/png" | "image/webp";
const ACCEPTED: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Server-side upload budget, shared with the request-body ceiling. */
export function readMaxUploadBytes(): number {
  return numEnv("MAX_UPLOAD_BYTES", 4 * 1024 * 1024);
}

/**
 * Server-side re-validation (never trust the client):
 * declared type, magic bytes, decodability, pixel size, byte size.
 * Returns the image re-encoded as JPEG so every provider gets a uniform input.
 */
export async function validateImage(file: File): Promise<{ buffer: Buffer; mime: SupportedMime }> {
  if (!ACCEPTED.has(file.type)) {
    throw new ApiError("invalid_image", 415, `Unsupported MIME type "${file.type}".`);
  }

  // Vercel caps a function request body at 4.5 MB; stay under it and let the
  // client do the heavy compression (it re-encodes to a <=2048px JPEG).
  const maxBytes = readMaxUploadBytes();
  if (file.size > maxBytes) {
    throw new ApiError("invalid_image", 413, `Image exceeds ${maxBytes} bytes.`);
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffMagicBytes(buf);
  if (!sniffed || sniffed !== file.type) {
    throw new ApiError("invalid_image", 415, "File content does not match its declared image type.");
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new ApiError("invalid_image", 415, "Image could not be decoded.");
  }

  const maxDim = numEnv("MAX_IMAGE_DIMENSION", 4096);
  if ((meta.width ?? 0) > maxDim || (meta.height ?? 0) > maxDim) {
    throw new ApiError("invalid_image", 413, `Image exceeds ${maxDim}px on its long edge.`);
  }

  const buffer = await sharp(buf).rotate().jpeg({ quality: 90 }).toBuffer();
  return { buffer, mime: "image/jpeg" };
}

function sniffMagicBytes(buf: Buffer): SupportedMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) return "image/png";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return null;
}
