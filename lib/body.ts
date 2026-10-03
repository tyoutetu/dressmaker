import { ApiError } from "./errors";
import type { GenErrorCode } from "./errors";

/**
 * Bounded request-body reading for the Web-standard function entrypoints.
 *
 * A serverless function must not buffer an unbounded body before application
 * validation. Every body read here is capped by an early `content-length` check
 * *and* by a streaming byte counter: once the ceiling is passed the extra bytes
 * are drained and discarded (never retained), so memory stays bounded even for a
 * chunked body that declares no length.
 */

/** Room for multipart boundaries and field headers on top of the image budget. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function requestBodyLimitBytes(maxUploadBytes: number): number {
  return maxUploadBytes + MULTIPART_OVERHEAD_BYTES;
}

/** True when the declared length alone already exceeds the ceiling. */
export function declaredBodyTooLarge(headers: Headers, maxBytes: number): boolean {
  const declared = headers.get("content-length");
  if (!declared) return false;
  const value = Number(declared);
  return Number.isFinite(value) && value > maxBytes;
}

/**
 * Read a multipart body with a hard byte ceiling, then parse it. The body is
 * re-wrapped so `formData()` sees the same `content-type` boundary the client
 * sent; multipart uploads keep working exactly as before.
 */
export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const body = await readBoundedBytes(request, maxBytes, "invalid_image");
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const rebuilt = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
  try {
    return await rebuilt.formData();
  } catch {
    throw new ApiError("bad_request", 400, "Expected a multipart/form-data body.");
  }
}

/** Read a JSON body with a hard byte ceiling. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const body = await readBoundedBytes(request, maxBytes, "bad_request");
  try {
    return JSON.parse(body.toString("utf8") || "null");
  } catch {
    throw new ApiError("bad_request", 400, "Expected a JSON body.");
  }
}

async function readBoundedBytes(
  request: Request,
  maxBytes: number,
  code: GenErrorCode,
): Promise<Buffer> {
  if (declaredBodyTooLarge(request.headers, maxBytes)) {
    throw new ApiError(code, 413, `Request body exceeds ${maxBytes} bytes.`);
  }

  const reader = request.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ApiError(code, 413, `Request body exceeds ${maxBytes} bytes.`);
    }
    return buffer;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (overflow) continue; // drain without buffering so the producer never stalls on a cancel
    total += value.byteLength;
    if (total > maxBytes) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(Buffer.from(value));
  }
  if (overflow) {
    throw new ApiError(code, 413, `Request body exceeds ${maxBytes} bytes.`);
  }
  return Buffer.concat(chunks);
}
