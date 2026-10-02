/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Vercel API deployment, e.g. https://dressmaker-api.vercel.app */
  readonly VITE_API_BASE?: string;
  /** GA4 measurement ID, e.g. G-XXXXXXXXXX. Leave empty to disable analytics. */
  readonly VITE_GA4_ID?: string;
  /** Optional base path for sub-path hosting (GitHub Pages project sites). */
  readonly VITE_BASE_PATH?: string;
  /**
   * Public address of this site, e.g. https://user.github.io/dressmaker/.
   * The share card's QR code encodes exactly this, so leaving it empty simply
   * hides the share control rather than printing a code that leads nowhere.
   */
  readonly VITE_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
