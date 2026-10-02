declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const GA_ID = import.meta.env.VITE_GA4_ID;

let initialized = false;

function ensureGtag(): void {
  if (!GA_ID || initialized) return;
  initialized = true;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  const gtag = (...args: unknown[]) => window.dataLayer.push(args);
  window.gtag = gtag;

  gtag("js", new Date());
  gtag("config", GA_ID);
}

/**
 * Optional GA4 helper. It stays quiet unless VITE_GA4_ID is configured, and it
 * only ever receives low-cardinality labels: never an image, a file name,
 * feedback text or anything else that could identify a visitor.
 */
export function track(event: string, params: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  ensureGtag();
  if (window.gtag && GA_ID) {
    window.gtag("event", event, params);
  }
  if (import.meta.env.DEV) {
    console.debug(`[ga4] ${event}`, params);
  }
}
