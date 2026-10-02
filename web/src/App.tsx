import { useCallback, useEffect, useRef, useState } from "react";
import { NpcPicker } from "./components/NpcPicker";
import { Uploader } from "./components/Uploader";
import { ResultSection } from "./components/ResultSection";
import { Faq } from "./components/Faq";
import { QuotaMeter } from "./components/QuotaMeter";
import { IconAlert, IconCheck, IconClock, IconCustomer, IconImage, IconSpark } from "./components/Icons";
import type { NpcConfig } from "./npcs";
import { getClientId, getUtm, type Utm } from "./lib/storage";
import { prepareImage, releasePreview, type PreparedImage } from "./lib/image";
import {
  failureChargeNote,
  generationAllowed,
  quotaBlockCopy,
  type CountedState,
  type QuotaState,
} from "./lib/outcome";
import {
  ApiError,
  GENERATION_TIMEOUT_MS,
  fetchHealth,
  fetchQuota,
  isApiConfigured,
  requestGeneration,
  timeoutSignal,
  type GenerateResponse,
  type QuotaSnapshot,
} from "./lib/api";
import { formatResetMoment } from "./lib/format";
import { normalizeSiteUrl } from "./lib/shareCard";
import { track } from "./lib/analytics";

type Phase = "idle" | "preparing" | "generating" | "success" | "failed" | "blocked";

interface Failure {
  code: string;
  message: string;
  variant?: "network" | "global" | "disabled";
  /** `unknown` when the browser lost the response and cannot tell. */
  counted: CountedState;
}

const QUOTA_POLL_MS = 180_000;

export default function App() {
  const [selectedNpc, setSelectedNpc] = useState<NpcConfig | null>(null);
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [quotaState, setQuotaState] = useState<QuotaState>("checking");
  const [mockMode, setMockMode] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const clientIdRef = useRef("");
  const utmRef = useRef<Utm>({});
  const preparedRef = useRef<PreparedImage | null>(null);
  const busyRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const pickTokenRef = useRef(0);
  const attemptRef = useRef(0);

  const busy = phase === "preparing" || phase === "generating";
  const apiConfigured = isApiConfigured();
  // Resolved once: the share card's QR code encodes exactly this address, and a
  // missing/unusable value hides sharing rather than printing a dead code.
  const siteUrl = normalizeSiteUrl(import.meta.env.VITE_SITE_URL);

  // ---------------------------------------------------------------- quota ----

  const refreshQuota = useCallback(async () => {
    if (!isApiConfigured()) {
      setQuotaState("stale");
      return;
    }
    try {
      const { quota: next, mock } = await fetchQuota(timeoutSignal(12_000));
      setQuota(next);
      setQuotaState("fresh");
      if (mock) setMockMode(true);
    } catch {
      // Keep the last known numbers for display, but fail closed: new paid
      // attempts stay disabled until a refresh actually succeeds.
      setQuotaState("stale");
    }
  }, []);

  const retryQuota = useCallback(() => {
    setQuotaState("checking");
    void refreshQuota();
  }, [refreshQuota]);

  useEffect(() => {
    clientIdRef.current = getClientId();
    utmRef.current = getUtm();
    track("tool_view", { source: utmRef.current.source, campaign: utmRef.current.campaign });

    void refreshQuota();
    void fetchHealth(timeoutSignal(12_000))
      .then((health) => {
        if (health.provider === "mock") setMockMode(true);
      })
      .catch(() => undefined);

    const onFocus = () => void refreshQuota();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshQuota();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshQuota]);

  // Keeps the countdown live and picks up the UTC rollover without a reload.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (quota?.reset_at && Date.parse(quota.reset_at) <= current) void refreshQuota();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [quota?.reset_at, refreshQuota]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshQuota(), QUOTA_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshQuota]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      releasePreview(preparedRef.current);
    },
    [],
  );

  // --------------------------------------------------------------- inputs ----

  function clearOutput(): void {
    setResult(null);
    setFailure(null);
    setPhase("idle");
  }

  function handleSelectNpc(npc: NpcConfig): void {
    if (busyRef.current || npc.id === selectedNpc?.id) return;
    track("npc_selected", { npc_id: npc.id });
    if (result) track("switch_npc_after_result", { npc_id: npc.id, previous_npc_id: selectedNpc?.id });
    setSelectedNpc(npc);
    clearOutput();
  }

  function handleFile(file: File): void {
    if (busyRef.current) return;
    // Every pick gets a token: a slow decode from an earlier pick can never
    // overwrite a newer one.
    const token = ++pickTokenRef.current;
    setUploadError(null);
    setPhase("preparing");
    track("image_upload_started");

    void prepareImage(file)
      .then((next) => {
        if (token !== pickTokenRef.current) {
          releasePreview(next);
          return;
        }
        releasePreview(preparedRef.current);
        preparedRef.current = next;
        setPrepared(next);
        clearOutput();
        track("image_upload_success", { width: next.width, height: next.height });
      })
      .catch((error: unknown) => {
        if (token !== pickTokenRef.current) return;
        setPhase("idle");
        setUploadError(
          error instanceof Error ? error.message : "That image could not be used. Please try another.",
        );
      });
  }

  function clearUpload(): void {
    if (busyRef.current) return;
    pickTokenRef.current += 1;
    releasePreview(preparedRef.current);
    preparedRef.current = null;
    setPrepared(null);
    setUploadError(null);
    // A result is only meaningful for the input that produced it.
    clearOutput();
  }

  // ------------------------------------------------------------ generation ----

  // Generation needs a *fresh* authoritative answer that still has headroom.
  const quotaAvailable = quotaState === "fresh" && Boolean(quota?.available);
  const quotaBlocks = quotaState === "fresh" && Boolean(quota && !quota.available);
  const blockedVariant = failure?.variant ?? (quotaBlocks ? quota?.variant : undefined);
  const ready = Boolean(selectedNpc && prepared);
  const canGenerate = generationAllowed({ apiConfigured, quotaState, quota, ready, busy });
  const dailyAllowance = quota && quota.limit > 0 ? quota.limit : 3;

  const blockedCopy = blockedVariant && blockedVariant !== "ok" ? quotaBlockCopy(blockedVariant) : null;

  async function generate(kind: "generate" | "regenerate"): Promise<void> {
    // Synchronous guard: a double click cannot start two paid attempts.
    if (busyRef.current || !selectedNpc || !prepared) return;
    if (!quotaAvailable) {
      setPhase("blocked");
      return;
    }

    busyRef.current = true;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    setFailure(null);
    setResult(null);
    setPhase("generating");
    track(kind === "regenerate" ? "regenerate_clicked" : "generate_clicked", {
      npc_id: selectedNpc.id,
      attempt_number: attempt,
    });

    const controller = new AbortController();
    requestRef.current = controller;
    let clientTimedOut = false;
    const timer = window.setTimeout(() => {
      clientTimedOut = true;
      controller.abort(new DOMException("Client timeout", "TimeoutError"));
    }, GENERATION_TIMEOUT_MS);

    try {
      const response = await requestGeneration({
        npcId: selectedNpc.id,
        prepared,
        clientId: clientIdRef.current,
        source: utmRef.current.source,
        campaign: utmRef.current.campaign,
        signal: controller.signal,
      });
      if (controller.signal.aborted && !clientTimedOut) return;
      setResult(response);
      setQuota(response.quota);
      setQuotaState("fresh");
      if (response.mock) setMockMode(true);
      setPhase("success");
      track("generation_success", { npc_id: selectedNpc.id, attempt_number: attempt });
    } catch (error) {
      if (controller.signal.aborted && !clientTimedOut) return;
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError("unknown", "Something went wrong. Please try again.", 0);
      if (apiError.quota) setQuota(apiError.quota);

      if (apiError.code === "limit_reached") {
        setFailure({
          code: apiError.code,
          message: apiError.message,
          variant: apiError.variant ?? "network",
          counted: "false",
        });
        setPhase("blocked");
        track("limit_reached", { npc_id: selectedNpc.id, variant: apiError.variant ?? "network" });
      } else {
        setFailure({
          code: apiError.code,
          message: apiError.message,
          counted: apiError.counted,
        });
        setPhase("failed");
        track("generation_failed", {
          npc_id: selectedNpc.id,
          error_type: apiError.code,
          attempt_number: attempt,
        });
      }
    } finally {
      window.clearTimeout(timer);
      if (requestRef.current === controller) requestRef.current = null;
      busyRef.current = false;
      // The server may have dispatched (and counted) an attempt even when the
      // browser never saw the response, so always re-read the authoritative
      // counter after a completion or an error. No automatic retry of the
      // paid call happens here — only the free quota read.
      void refreshQuota();
    }
  }

  function handleTryAnother(): void {
    if (busyRef.current) return;
    track("switch_npc_after_result", { previous_npc_id: selectedNpc?.id });
    setResult(null);
    setFailure(null);
    setSelectedNpc(null);
    setPhase("idle");
    document.getElementById("step-customer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----------------------------------------------------------------- view ----

  return (
    <div className="page">
      <a className="skip-link" href="#tool">
        Skip to the tool
      </a>

      <header className="topbar">
        <p className="topbar-brand">
          Dressmaker <span>dress preview</span>
          <span className="topbar-flag">unofficial beta</span>
        </p>
        <QuotaMeter quota={quota} now={now} state={quotaState} onRetry={retryQuota} />
      </header>

      {mockMode && (
        <p className="banner" role="status">
          <IconAlert width={18} height={18} />
          <span>
            <strong>Local mock running.</strong> Previews from this page are drawn placeholders, not AI
            output, and the daily limit behaves exactly as it does in production.
          </span>
        </p>
      )}

      {(!apiConfigured || quotaState === "stale") && (
        <p className="banner banner-warn" role="alert">
          <IconAlert width={18} height={18} />
          <span>
            <strong>Previews are unavailable right now.</strong>{" "}
            {apiConfigured
              ? "We could not read today's preview limit, so new previews are paused until it loads again."
              : "This page cannot reach the preview service at the moment."}
          </span>
          {apiConfigured && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={retryQuota}
              disabled={quotaState === "checking"}
            >
              {quotaState === "checking" ? "Checking…" : "Check availability"}
            </button>
          )}
        </p>
      )}

      <header className="hero">
        <h1>See your dress on Rose or Priya</h1>
        <p className="lede">
          Upload a screenshot of a dress you made in <em>Dressmaker</em>, pick a customer, and generate a
          preview of them wearing it.
        </p>
      </header>

      <main id="tool">
        <section className="step" id="step-customer" aria-labelledby="step-customer-heading">
          <h2 id="step-customer-heading">
            <span className="step-num" aria-hidden="true">
              1
            </span>
            Pick a customer
          </h2>
          <p className="step-note">
            <IconCustomer width={17} height={17} />
            Rose and Priya are available in this beta. Choose Rose or Priya to continue.
          </p>
          <NpcPicker selectedId={selectedNpc?.id ?? null} onSelect={handleSelectNpc} disabled={busy} />
        </section>

        <section className="step" aria-labelledby="step-upload-heading">
          <h2 id="step-upload-heading">
            <span className="step-num" aria-hidden="true">
              2
            </span>
            Add your dress screenshot
          </h2>
          <p className="step-note">
            <IconImage width={17} height={17} />
            A finished-dress or mannequin screenshot works best. Front or three-quarter views are easiest
            for the AI to read.
          </p>
          <Uploader
            prepared={prepared}
            error={uploadError}
            onFile={handleFile}
            onClear={clearUpload}
            disabled={busy}
          />
        </section>

        <section className="step" aria-labelledby="step-generate-heading">
          <h2 id="step-generate-heading">
            <span className="step-num" aria-hidden="true">
              3
            </span>
            Generate the preview
          </h2>

          <ul className="checklist">
            <li className={selectedNpc ? "is-done" : undefined}>
              <span className="check-mark" aria-hidden="true">
                {selectedNpc && <IconCheck width={12} height={12} strokeWidth={3} />}
              </span>
              {selectedNpc ? `Customer: ${selectedNpc.name}` : "Pick a customer above"}
            </li>
            <li className={prepared ? "is-done" : undefined}>
              <span className="check-mark" aria-hidden="true">
                {prepared && <IconCheck width={12} height={12} strokeWidth={3} />}
              </span>
              {prepared ? "Screenshot ready" : "Add a dress screenshot"}
            </li>
          </ul>

          <div className="generate-row">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => void generate("generate")}
              disabled={!canGenerate}
            >
              <IconSpark width={19} height={19} />
              {phase === "generating" ? "Generating…" : (blockedCopy?.buttonLabel ?? "Generate preview")}
            </button>
          </div>

          <p className="quota-note">
            <IconClock width={16} height={16} />
            Sending counts as one attempt, even if the connection or the AI provider fails afterwards. Each
            network gets up to {dailyAllowance} a day, so a shared Wi-Fi shares them, and they reset at{" "}
            {formatResetMoment(quota?.reset_at)}.
          </p>

          <div className="status-area" aria-live="polite">
            {phase === "preparing" && (
              <p className="status status-busy">
                <span className="spinner" aria-hidden="true" />
                Reading your screenshot…
              </p>
            )}
            {phase === "generating" && (
              <p className="status status-busy">
                <span className="spinner" aria-hidden="true" />
                {selectedNpc ? `Stitching ${selectedNpc.name}'s dress…` : "Generating…"} Keep this tab open.
                If it stops, the attempt may still have been used.
              </p>
            )}
            {phase === "failed" && failure && (
              <p className="status status-error" role="alert">
                <strong>That attempt did not finish.</strong> {failure.message}
                <span className="status-note">{failureChargeNote(failure.counted)}</span>
              </p>
            )}
            {blockedCopy && (
              <p className="status status-warn" role="alert">
                <strong>{blockedCopy.title}</strong>{" "}
                {blockedVariant === "network" && failure?.message ? failure.message : blockedCopy.body}
                <span className="status-note">Resets {formatResetMoment(quota?.reset_at)}.</span>
              </p>
            )}
          </div>
        </section>

        {result && selectedNpc && (
          <ResultSection
            key={result.generation_id || "result"}
            result={result}
            npc={selectedNpc}
            source={utmRef.current.source}
            now={now}
            quota={quota}
            busy={busy}
            canRegenerate={quotaAvailable}
            siteUrl={siteUrl}
            onRegenerate={() => void generate("regenerate")}
            onTryAnother={handleTryAnother}
          />
        )}

        <Faq />
      </main>

      <footer className="footer">
        <p>
          Unofficial, fan-made beta. <em>Dressmaker</em>, its characters and its art belong to their
          respective owners. Previews are experimental and may not match the in-game result.
        </p>
        <p>
          Please upload Dressmaker screenshots only, not photos of real people. This app does not save your
          uploaded screenshot file. It is sent to the AI provider that generates the preview, and that
          provider handles it under its own policy.
        </p>
      </footer>
    </div>
  );
}
