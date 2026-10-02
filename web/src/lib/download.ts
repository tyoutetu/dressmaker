/**
 * Result download.
 *
 * The PNG arrives as a base64 data URL (it is rendered straight into an <img>),
 * and a data URL cannot back a real <a download> control. The bytes are decoded
 * into a Blob and handed to the browser through an object URL, which the result
 * component points a genuine link at and releases when the result changes or the
 * component unmounts. Nothing here clicks anything: the visitor's own click on
 * the link is what starts the native download.
 */

export interface ResultDownload {
  /** Object URL for this result's Blob, ready for an <a href>. */
  url: string;
  /** Suggested file name for the `download` attribute. */
  filename: string;
  /** Release the object URL. Safe to call more than once. */
  dispose(): void;
}

/** Decode a `data:` URL into a Blob. Pure and unit-testable. */
export function dataUrlToBlob(dataUrl: string): Blob {
  if (!dataUrl.startsWith("data:")) throw new Error("Not a data URL.");
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Malformed data URL.");

  const header = dataUrl.slice("data:".length, comma);
  const mime = header.split(";")[0] || "application/octet-stream";
  const payload = dataUrl.slice(comma + 1);
  const bytes = /;base64$/i.test(header)
    ? base64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: mime });
}

/**
 * Decode the result image and expose it as an object URL for the download link.
 * One call owns exactly one object URL: whoever creates it must `dispose()` it,
 * which is what keeps React Strict Mode's extra mount/cleanup cycle leak-free.
 * Throws when the payload is not a decodable data URL, so the caller can fall
 * back to an honest disabled control instead of shipping a dead link.
 */
export function prepareResultDownload(dataUrl: string, filename: string): ResultDownload {
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  let released = false;
  return {
    url,
    filename,
    dispose(): void {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}

/** Download name for a result: `dressmaker-<npc>-<utc timestamp>.png`. */
export function resultFilename(npcId: string, at: Date = new Date()): string {
  return `dressmaker-${npcId}-${at.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
}

function base64ToBytes(payload: string): Uint8Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
