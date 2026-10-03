/**
 * Share card: the part that makes a preview travel.
 *
 * The visitor downloads (or hands to their phone's share sheet) a single PNG
 * that carries the preview *and* a way back — the site address plus a QR code
 * pointing at it. Everything is composed on the visitor's own canvas, so a share
 * costs no server work, no upload and no provider call.
 *
 * The pure helpers (URL normalisation, geometry, file name, capability probe)
 * are deliberately separated from the canvas code so they can be unit-tested in
 * Node without a DOM — the same split `download.ts` uses.
 */

import { encodeQr } from "./qr.js";

/** 4:5 — the tallest ratio that survives uncropped on the usual social feeds. */
export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1350;

const MARGIN = 60;
const PHOTO_SIZE = SHARE_CARD_WIDTH - MARGIN * 2;
const PHOTO_TOP = MARGIN;
const FOOTER_TOP = PHOTO_TOP + PHOTO_SIZE;
const FOOTER_HEIGHT = SHARE_CARD_HEIGHT - FOOTER_TOP;
/** Square reserved for the QR code *and* its mandatory light margin. */
const QR_BLOCK = 264;
/** Never let the text column run into that square. */
const QR_GAP = 36;

export interface ShareLayout {
  width: number;
  height: number;
  photo: { x: number; y: number; size: number };
  /** The reserved square; `qrGeometry` fits the code and its margin inside it. */
  qr: { x: number; y: number; block: number };
  text: { x: number; maxWidth: number; footerTop: number; footerHeight: number };
}

/**
 * Geometry for the card. Pure so a test can assert nothing overflows or
 * overlaps — overflow is the failure that would silently ship a broken QR.
 */
export function shareLayout(): ShareLayout {
  return {
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
    photo: { x: MARGIN, y: PHOTO_TOP, size: PHOTO_SIZE },
    qr: {
      x: SHARE_CARD_WIDTH - MARGIN - QR_BLOCK,
      y: FOOTER_TOP + Math.round((FOOTER_HEIGHT - QR_BLOCK) / 2),
      block: QR_BLOCK,
    },
    text: {
      x: MARGIN,
      maxWidth: SHARE_CARD_WIDTH - MARGIN * 2 - QR_BLOCK - QR_GAP,
      footerTop: FOOTER_TOP,
      footerHeight: FOOTER_HEIGHT,
    },
  };
}

export interface QrGeometry {
  /** Side of the drawn code, excluding the margin. */
  size: number;
  /** Light margin on each side — exactly four modules, as the spec requires. */
  quietZone: number;
  /** Offset of the code inside its block. */
  origin: number;
  moduleSize: number;
}

/**
 * Fit a QR code and its light margin into a square block.
 *
 * The margin has to be four *modules*, not four pixels, so it cannot be a
 * constant: a version 1 code has 21 modules and a version 10 code has 57, which
 * at a fixed 264px block means module sizes of 9.1px and 4.1px and therefore
 * margins of 36px and 16px. Solving `size + 8 * (size / modules) = block` keeps
 * the ratio exact at every version instead of guessing a pixel value.
 */
export function qrGeometry(modules: number, block: number = QR_BLOCK): QrGeometry {
  if (!Number.isFinite(modules) || modules <= 0) throw new Error("QR modules must be positive.");
  const size = (block * modules) / (modules + 8);
  return {
    size,
    quietZone: (block * 4) / (modules + 8),
    origin: (block - size) / 2,
    moduleSize: size / modules,
  };
}

/**
 * Normalise the configured site address into something worth encoding.
 *
 * Returns null when nothing usable is configured, and the caller then hides
 * sharing entirely rather than printing a QR that leads nowhere. The path is
 * kept (GitHub Pages project sites live under `/<repo>/`) while query and hash
 * are dropped, so the QR points at the tool and not at somebody's campaign
 * parameters.
 */
export function normalizeSiteUrl(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The address as printed on the card: no scheme, no trailing slash. */
export function displayUrl(normalized: string): string {
  return normalized.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Download name for a share card: `dressmaker-<npc>-share-<utc timestamp>.png`. */
export function shareFilename(npcId: string, at: Date = new Date()): string {
  return `dressmaker-${npcId}-share-${at.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
}

export interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

/**
 * Whether this browser can hand a real image file to another app. Desktop
 * browsers mostly cannot, and there the control falls back to a download.
 * Wrapped in try/catch because `canShare` throws on some platforms when handed
 * a file type it does not accept.
 */
export function canShareImage(
  nav: ShareCapableNavigator | undefined,
  file: { type: string },
): boolean {
  if (!nav || typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file as File] }) === true;
  } catch {
    return false;
  }
}

/** Copy shown on the card. Kept here so the wording is testable, not buried in JSX. */
export function shareHeadline(npcName: string): string {
  return `${npcName} is wearing a dress made in Dressmaker`;
}

export function shareDisclaimer(): string {
  return "AI preview — not an in-game result. Unofficial, fan-made beta.";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The preview image could not be loaded for sharing."));
    image.src = src;
  });
}

/** `roundRect` is recent; draw the path by hand so older browsers still work. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export interface ShareCardInput {
  /** The result image as a data URL (which is how the API returns it). */
  imageDataUrl: string;
  /** Already normalised by `normalizeSiteUrl`. */
  siteUrl: string;
  npcName: string;
}

export interface PreparedShareCard {
  /** Object URL for the card, ready for an `<a href>` download. */
  url: string;
  /** The card as a File, ready for `navigator.share`. */
  file: File;
  filename: string;
  /** Release the object URL. Safe to call more than once. */
  dispose(): void;
}

/**
 * Wrap a composed card in exactly one object URL plus the File used by the
 * share sheet. Whoever calls this owns the URL and must `dispose()` it, which is
 * what keeps React Strict Mode's extra mount/cleanup cycle leak-free.
 */
export function prepareShareCard(blob: Blob, filename: string): PreparedShareCard {
  const url = URL.createObjectURL(blob);
  let released = false;
  return {
    url,
    file: new File([blob], filename, { type: "image/png" }),
    filename,
    dispose(): void {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * Render the share card and return it as a PNG Blob.
 * Throws when the preview cannot be decoded or the canvas cannot export.
 */
export async function composeShareCard(input: ShareCardInput): Promise<Blob> {
  const layout = shareLayout();
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not prepare the share image.");

  const photo = await loadImage(input.imageDataUrl);
  const matrix = encodeQr(input.siteUrl).matrix;
  const geometry = qrGeometry(matrix.length, layout.qr.block);
  const fontStack = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  // Page background, matching the site's warm cream.
  ctx.fillStyle = "#faf5ee";
  ctx.fillRect(0, 0, layout.width, layout.height);

  // The preview itself, rounded to match the site's cards.
  ctx.save();
  roundedRectPath(ctx, layout.photo.x, layout.photo.y, layout.photo.size, layout.photo.size, 28);
  ctx.clip();
  ctx.drawImage(photo, layout.photo.x, layout.photo.y, layout.photo.size, layout.photo.size);
  ctx.restore();

  const { text, qr } = layout;
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#241d1a";
  ctx.font = `600 40px ${fontStack}`;
  ctx.fillText("Dressmaker dress preview", text.x, text.footerTop + 74);

  ctx.fillStyle = "#8a7f78";
  ctx.font = `400 25px ${fontStack}`;
  ctx.fillText(shareHeadline(input.npcName), text.x, text.footerTop + 116);

  ctx.fillStyle = "#c2586e";
  ctx.font = `600 30px ${fontStack}`;
  ctx.fillText(displayUrl(input.siteUrl), text.x, text.footerTop + 170);

  ctx.fillStyle = "#8a7f78";
  ctx.font = `400 21px ${fontStack}`;
  ctx.fillText("Scan to make your own", text.x, text.footerTop + 208);

  ctx.fillStyle = "#8a7f78";
  ctx.font = `400 18px ${fontStack}`;
  ctx.fillText(shareDisclaimer(), text.x, text.footerTop + text.footerHeight - 26);

  // QR: a white block (the light margin), then the modules at an exact size.
  const blockX = qr.x;
  const blockY = qr.y;
  ctx.fillStyle = "#ffffff";
  roundedRectPath(ctx, blockX, blockY, qr.block, qr.block, 20);
  ctx.fill();

  const qrX = blockX + geometry.origin;
  const qrY = blockY + geometry.origin;
  ctx.fillStyle = "#241d1a";
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      if (!matrix[row][col]) continue;
      // Round outward so adjacent modules never leave a hairline seam.
      const left = qrX + Math.floor(col * geometry.moduleSize);
      const top = qrY + Math.floor(row * geometry.moduleSize);
      const right = qrX + Math.ceil((col + 1) * geometry.moduleSize);
      const bottom = qrY + Math.ceil((row + 1) * geometry.moduleSize);
      ctx.fillRect(left, top, right - left, bottom - top);
    }
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Your browser could not export the share image.");
  return blob;
}
