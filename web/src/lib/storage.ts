/**
 * localStorage is not always available: Safari private mode, storage disabled
 * in settings, and some embedded webviews all throw on access. Nothing here is
 * load-bearing — the quota lives on the server — so every read and write falls
 * back to an in-memory store instead of breaking the page.
 */

const ANON_ID_KEY = "dm_anonymous_id";
const UTM_SOURCE_KEY = "dm_utm_source";
const UTM_CAMPAIGN_KEY = "dm_utm_campaign";
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // storage unavailable — fall through to the in-memory copy
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the in-memory copy still covers this session
  }
}

/**
 * A per-browser id used for analytics correlation only.
 * It is never the quota identity: clearing storage does not reset the limit.
 */
export function getClientId(): string {
  const existing = read(ANON_ID_KEY);
  if (existing) return existing;
  const id = randomId();
  write(ANON_ID_KEY, id);
  return id;
}

function randomId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface Utm {
  source?: string;
  campaign?: string;
}

/** Capture UTM on first entry and keep it for the session. */
export function getUtm(): Utm {
  let querySource: string | null = null;
  let queryCampaign: string | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    querySource = params.get("utm_source")?.trim() || null;
    queryCampaign = params.get("utm_campaign")?.trim() || null;
  } catch {
    // no query string available — fall back to whatever was stored
  }

  if (querySource) write(UTM_SOURCE_KEY, querySource);
  if (queryCampaign) write(UTM_CAMPAIGN_KEY, queryCampaign);

  return {
    source: querySource ?? read(UTM_SOURCE_KEY) ?? undefined,
    campaign: queryCampaign ?? read(UTM_CAMPAIGN_KEY) ?? undefined,
  };
}
