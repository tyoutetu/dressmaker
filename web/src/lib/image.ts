export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const TARGET_MAX_EDGE = 2048;

export class UploadError extends Error {}

export interface PreparedImage {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
}

/**
 * Client-side pre-processing: validate type/size, honour EXIF orientation,
 * compress the long edge to <=2048px and re-encode as JPEG so uploads stay
 * small and the model input stays cheap. Nothing is ever cropped.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new UploadError("Only JPEG, PNG or WebP screenshots are supported.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new UploadError("That image is over 4 MB. Please pick a smaller screenshot.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new UploadError("That file doesn't look like a readable image.");
    }
  }

  const scale = Math.min(1, TARGET_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new UploadError("Your browser could not process that image.");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  );
  if (!blob) {
    throw new UploadError("Your browser could not process that image.");
  }

  return { blob, previewUrl: URL.createObjectURL(blob), width, height };
}

export function releasePreview(prepared: PreparedImage | null): void {
  if (!prepared) return;
  try {
    URL.revokeObjectURL(prepared.previewUrl);
  } catch {
    // the object URL was already released
  }
}
