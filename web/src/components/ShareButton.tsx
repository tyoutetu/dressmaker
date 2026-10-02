import { useEffect, useState } from "react";
import {
  canShareImage,
  composeShareCard,
  prepareShareCard,
  shareFilename,
  type PreparedShareCard,
  type ShareCapableNavigator,
} from "../lib/shareCard";
import { IconAlert, IconShare } from "./Icons";

interface Props {
  /** The result image as returned by the API (a data URL). */
  imageDataUrl: string;
  npcId: string;
  npcName: string;
  /** Normalised site address the QR code points at. */
  siteUrl: string;
  busy: boolean;
}

type Phase = "preparing" | "ready" | "shared" | "failed";

/**
 * "Share" hands the visitor a single PNG carrying the preview plus a QR code
 * back to the site. The card is composed once, when the result appears — not on
 * click — so the control is either genuinely ready or honestly unavailable,
 * exactly like the download link beside it.
 *
 * On a phone the composed file goes to the system share sheet; on a desktop,
 * where there is no share sheet for files, the same control is a real
 * `<a download>` so the browser's own activation starts the download.
 */
export function ShareButton({ imageDataUrl, npcId, npcName, siteUrl, busy }: Props) {
  const [card, setCard] = useState<PreparedShareCard | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let prepared: PreparedShareCard | null = null;
    let cancelled = false;

    composeShareCard({ imageDataUrl, siteUrl, npcName })
      .then((blob) => {
        if (cancelled) return;
        prepared = prepareShareCard(blob, shareFilename(npcId));
        setCard(prepared);
        setPhase("ready");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCard(null);
        setPhase("failed");
        setError(cause instanceof Error ? cause.message : "The share image could not be prepared.");
      });

    return () => {
      cancelled = true;
      prepared?.dispose();
    };
  }, [imageDataUrl, siteUrl, npcName, npcId]);

  async function share(): Promise<void> {
    if (!card || phase === "preparing") return;
    const nav = navigator as ShareCapableNavigator;
    if (!canShareImage(nav, card.file)) return;
    try {
      await nav.share!({
        files: [card.file],
        title: `${npcName} is wearing your dress`,
        text: "Made with Dressmaker dress preview — scan the code to try it.",
      });
      setPhase("shared");
      setError(null);
    } catch (cause: unknown) {
      // Dismissing the share sheet is a normal outcome, not a failure.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setPhase("failed");
      setError("Sharing was cancelled by the browser. Use Download instead.");
    }
  }

  if (phase === "failed" || phase === "preparing") {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        disabled
        title={error ?? undefined}
      >
        {error ? <IconAlert width={18} height={18} /> : <IconShare width={18} height={18} />}
        {error ? "Share unavailable" : "Preparing share…"}
      </button>
    );
  }

  // Desktop: a genuine link, so the visitor's own click starts the download.
  if (!canShareImage(navigator as ShareCapableNavigator, card!.file)) {
    return (
      <a className="btn btn-secondary" href={card!.url} download={card!.filename}>
        <IconShare width={18} height={18} />
        Share image
      </a>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => void share()}
      disabled={busy}
    >
      <IconShare width={18} height={18} />
      {phase === "shared" ? "Shared" : "Share"}
    </button>
  );
}
