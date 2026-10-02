import { useEffect, useState } from "react";
import type { NpcConfig } from "../npcs";
import { sendFeedback, type GenerateResponse, type QuotaSnapshot } from "../lib/api";
import { prepareResultDownload, resultFilename, type ResultDownload } from "../lib/download";
import { formatCountdown, formatResetMoment, plural, secondsUntil } from "../lib/format";
import { track } from "../lib/analytics";
import { IconAlert, IconCheck, IconDownload, IconRefresh, IconSwap } from "./Icons";
import { ShareButton } from "./ShareButton";

type Rating = "yes" | "kind_of" | "no";

const RATINGS: Array<{ value: Rating; label: string }> = [
  { value: "yes", label: "Yes" },
  { value: "kind_of", label: "Kind of" },
  { value: "no", label: "No" },
];

interface Props {
  result: GenerateResponse;
  npc: NpcConfig;
  source?: string;
  now: number;
  quota: QuotaSnapshot | null;
  busy: boolean;
  canRegenerate: boolean;
  /** Normalised site address for the share card's QR code, or null when unset. */
  siteUrl: string | null;
  onRegenerate: () => void;
  onTryAnother: () => void;
}

/**
 * Remounted per generation (see the `key` in App), so feedback state can never
 * leak from one preview to the next.
 */
export function ResultSection({
  result,
  npc,
  source,
  now,
  quota,
  busy,
  canRegenerate,
  siteUrl,
  onRegenerate,
  onTryAnother,
}: Props) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [savedRating, setSavedRating] = useState<Rating | null>(null);
  const [note, setNote] = useState("");
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<"rating" | "note" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<ResultDownload | null>(null);
  const [downloadError, setDownloadError] = useState(false);

  const canRate = !busy && saving === null && result.generation_id.length > 0;

  /**
   * The download control is a real `<a download>` pointing at a Blob object URL,
   * so the browser's own activation starts a native download. The URL is created
   * here (never during render) and released on result change or unmount; each
   * effect run owns its own URL, so Strict Mode's mount → cleanup → mount cycle
   * cannot leak or leave a revoked href behind.
   */
  useEffect(() => {
    let prepared: ResultDownload | null = null;
    try {
      prepared = prepareResultDownload(result.image, resultFilename(npc.id));
    } catch {
      setDownload(null);
      setDownloadError(true);
      return;
    }
    setDownload(prepared);
    setDownloadError(false);
    return () => prepared?.dispose();
  }, [result.image, npc.id]);

  function handleDownloadClick(): void {
    track("result_downloaded", { npc_id: npc.id });
  }

  async function saveRating(value: Rating): Promise<void> {
    if (!canRate || value === savedRating) return;
    setRating(value);
    setError(null);
    setSaving("rating");
    track("result_feedback", { npc_id: npc.id, rating: value });
    try {
      await sendFeedback({
        generationId: result.generation_id,
        rating: value,
        feedbackText: note.trim() || undefined,
        source,
      });
      setSavedRating(value);
      setSavedNote(note.trim() || null);
    } catch {
      setError("Your answer could not be saved just now. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  async function saveNote(): Promise<void> {
    const clean = note.trim();
    if (!canRate) return;
    if (!clean) {
      setError("Write a note first — or leave the box empty.");
      return;
    }
    if (!rating) {
      setError("Pick Yes, Kind of or No above first; a note is saved with that answer.");
      return;
    }
    setError(null);
    setSaving("note");
    track("feedback_submitted", { npc_id: npc.id });
    try {
      await sendFeedback({
        generationId: result.generation_id,
        rating,
        feedbackText: clean,
        source,
      });
      setSavedRating(rating);
      setSavedNote(clean);
    } catch {
      setError("Your note could not be saved just now. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  const noteDirty = savedNote === null ? note.trim().length > 0 : note.trim() !== savedNote;
  const seconds = quota ? (secondsUntil(quota.reset_at, now) ?? 0) : null;

  return (
    <section className="step result" aria-labelledby="result-heading">
      <h2 id="result-heading">
        <span className="step-num" aria-hidden="true">
          <IconCheck width={16} height={16} strokeWidth={2.4} />
        </span>
        {npc.name} is wearing your dress
      </h2>

      <figure className="result-figure">
        <img
          src={result.image}
          alt={`AI preview of ${npc.name} wearing the dress from your screenshot`}
          decoding="async"
        />
        <figcaption>
          AI preview — the cut, colour and details can differ from the in-game result.
          {result.mock && <strong className="mock-flag">Local mock preview: placeholder art, no AI was called.</strong>}
        </figcaption>
      </figure>

      <div className="result-actions">
        {download ? (
          <a className="btn btn-primary" href={download.url} download={download.filename} onClick={handleDownloadClick}>
            <IconDownload width={18} height={18} />
            Download PNG
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled
            title={downloadError ? "The preview image could not be prepared for download." : undefined}
          >
            <IconDownload width={18} height={18} />
            {downloadError ? "Download unavailable" : "Preparing download…"}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onRegenerate} disabled={!canRegenerate || busy}>
          <IconRefresh width={18} height={18} />
          {busy ? "Generating…" : "Regenerate"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onTryAnother} disabled={busy}>
          <IconSwap width={18} height={18} />
          Try another customer
        </button>
      </div>

      {siteUrl && (
        <div className="share-row">
          <ShareButton
            imageDataUrl={result.image}
            npcId={npc.id}
            npcName={npc.name}
            siteUrl={siteUrl}
            busy={busy}
          />
          <p className="share-note">
            Share the preview with the address and a QR code on it, so anyone who sees it can make
            their own.
          </p>
        </div>
      )}

      {quota && (
        <p className="result-quota">
          {quota.variant === "global"
            ? "Today's shared preview budget is spent — new previews are paused until the reset"
            : quota.remaining > 0
            ? `${quota.remaining} of ${quota.limit} ${plural(quota.limit, "preview")} left today`
            : "That was the last preview for today"}
          {seconds !== null && ` · resets ${formatResetMoment(quota.reset_at)} · in ${formatCountdown(seconds)}`}
        </p>
      )}
      {!canRegenerate && !quota?.disabled && (
        <p className="result-quota is-warn">
          {quota?.variant === "global"
            ? "Regenerating is paused because the shared budget for today is spent. Your own allowance was not used up."
            : "Regenerating needs another preview. Come back after the daily reset."}
        </p>
      )}

      {result.generation_id && (
        <div className="feedback">
          <p className="feedback-question" id={`rate-${result.generation_id}`}>
            Did this look like the dress you made?
          </p>
          <div className="rating-row" role="group" aria-labelledby={`rate-${result.generation_id}`}>
            {RATINGS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`btn btn-rating${rating === value ? " is-picked" : ""}`}
                aria-pressed={rating === value}
                onClick={() => void saveRating(value)}
                disabled={!canRate}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="feedback-state" role="status">
            {savedRating === rating && rating !== null
              ? `Saved: ${RATINGS.find((entry) => entry.value === rating)?.label}. You can change it any time.`
              : "Your answer helps decide what to fix next."}
          </p>

          <label className="feedback-label" htmlFor={`note-${result.generation_id}`}>
            What looks wrong, or what should change?
          </label>
          <textarea
            id={`note-${result.generation_id}`}
            value={note}
            maxLength={500}
            rows={3}
            placeholder="Optional — for example: “the bow is missing” or “the skirt should be longer”."
            onChange={(event) => setNote(event.target.value)}
            disabled={busy || saving !== null}
          />
          <div className="feedback-foot">
            <span className="char-count">{note.length}/500</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void saveNote()}
              disabled={!canRate || !noteDirty}
            >
              {saving === "note" ? "Saving…" : savedNote !== null && !noteDirty ? "Note saved" : "Send note"}
            </button>
          </div>
          {!rating && (
            <p className="feedback-hint">Pick Yes, Kind of or No first — the note is saved with that answer.</p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              <IconAlert width={17} height={17} />
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
