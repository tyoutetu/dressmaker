import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Client identity for the cost-control quota.
 *
 * The ONLY trusted source of a client IP is Vercel's platform-overwritten
 * `x-vercel-forwarded-for` header, and only when the platform actually ran the
 * function (VERCEL=1). Everything else — `x-forwarded-for`, `x-real-ip`,
 * `forwarded`, query params, browser hints — is client-controlled and is never
 * read here. When no trusted address is available we fail closed.
 *
 * Raw IPs are never stored or logged: callers persist only the HMAC hash.
 */

export type IpFamily = 4 | 6;

export interface CanonicalIp {
  family: IpFamily;
  /** Canonical textual form: dotted quad for IPv4, compressed lowercase for IPv6. */
  canonical: string;
}

export type IpResolution =
  | { ok: true; ip: CanonicalIp; source: "vercel" | "local" }
  | { ok: false; reason: "trusted_ip_missing" | "trusted_ip_invalid" };

/** Identity used by the explicit local-only mode; never reachable on Vercel. */
export const LOCAL_MODE_IP: CanonicalIp = { family: 4, canonical: "127.0.0.1" };

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_WITH_PORT_RE = /^\d{1,3}(?:\.\d{1,3}){3}:/;
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/;

/** Parse a strict IPv4 dotted quad. Rejects "1.2.3", "1.2.3.4.5", "01x", "1.2.3.256". */
export function parseIpv4(input: string): CanonicalIp | null {
  const trimmed = input.trim();
  if (!IPV4_RE.test(trimmed)) return null;
  const parts = trimmed.split(".");
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return { family: 4, canonical: octets.join(".") };
}

/**
 * Parse and canonicalize an IPv6 address.
 *
 * The platform's own WHATWG URL parser implements RFC 5952 canonicalization
 * (lowercase, longest zero run compressed, IPv4-embedded groups rewritten), so
 * every equivalent spelling — including the full mapped form
 * `0:0:0:0:0:ffff:192.0.2.1` — lands on one identity. IPv4-mapped addresses
 * (`::ffff:a.b.c.d`) collapse onto the plain IPv4 identity; `::` and `::1` stay
 * IPv6, so no two unrelated hosts are ever merged.
 */
export function parseIpv6(input: string): CanonicalIp | null {
  let text = input.trim();
  if (text.startsWith("[") || text.endsWith("]")) {
    if (!(text.startsWith("[") && text.endsWith("]"))) return null;
    text = text.slice(1, -1);
  }
  // Brackets and zone/scope ids are never part of the identity we meter. The
  // platform sends a bare address; anything else is rejected rather than
  // silently coerced.
  if (text.includes("[") || text.includes("]") || text.includes("%")) return null;
  if (!text.includes(":")) return null;
  if (isIP(text) !== 6) return null;

  let canonical: string;
  try {
    canonical = new URL(`http://[${text}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }

  const groups = ipv6Groups(canonical);
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return { family: 4, canonical: v4 };
  }

  return { family: 6, canonical };
}

/** Normalize any accepted address form to its canonical representation. */
export function normalizeIp(input: string): CanonicalIp | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (text === "") return null;
  // A comma-separated list is a header concern, never one address.
  if (text.includes(",")) return null;
  if (text.includes(":")) return parseIpv6(text);
  return parseIpv4(text);
}

/** Expand a canonical (URL-normalized) IPv6 string into eight 16-bit groups. */
function ipv6Groups(text: string): number[] | null {
  const parts = text.split("::");
  if (parts.length > 2) return null;
  const head = toGroups(parts[0] === "" ? [] : parts[0].split(":"));
  const tail = toGroups(parts.length === 2 && parts[1] !== "" ? parts[1].split(":") : []);
  if (!head || !tail) return null;
  if (parts.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function toGroups(segments: string[]): number[] | null {
  const groups: number[] = [];
  for (const segment of segments) {
    if (!HEX_GROUP_RE.test(segment)) return null;
    groups.push(parseInt(segment, 16));
  }
  return groups;
}

export interface TrustedHeaderOptions {
  /** True only when the Vercel platform ran this function (VERCEL=1). */
  isVercel: boolean;
  /** Explicit, opt-in loopback mode for local development and tests. */
  localMode: boolean;
}

/**
 * Resolve the quota identity from request headers.
 * The header may carry a single address or a comma-separated list; only the
 * first entry is considered, mirroring how the platform writes it.
 */
export function resolveClientIp(
  headers: Headers,
  options: TrustedHeaderOptions,
): IpResolution {
  if (options.isVercel) {
    const raw = headers.get("x-vercel-forwarded-for");
    if (!raw || raw.trim() === "") return { ok: false, reason: "trusted_ip_missing" };
    const first = raw.split(",")[0]?.trim() ?? "";
    const ip = parseTrustedAddress(first);
    if (!ip) return { ok: false, reason: "trusted_ip_invalid" };
    return { ok: true, ip, source: "vercel" };
  }
  if (options.localMode) {
    return { ok: true, ip: LOCAL_MODE_IP, source: "local" };
  }
  return { ok: false, reason: "trusted_ip_missing" };
}

/**
 * Parse exactly one entry of the trusted header. The platform writes a bare
 * address; a well-formed `host:port` / `[v6]:port` is tolerated and the port is
 * validated, but a malformed port, a stray bracket, a zone id or a second list
 * entry invalidates the whole identity so the request fails closed.
 */
export function parseTrustedAddress(value: string): CanonicalIp | null {
  const text = value.trim();
  if (text === "" || text.includes(",")) return null;

  if (text.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
    if (!match) return null;
    if (match[2] !== undefined && !isValidPort(match[2])) return null;
    return parseIpv6(match[1]);
  }

  // A bare IPv6 address contains colons of its own, so only a dotted quad may be
  // read as `host:port`.
  if (text.includes(":") && !IPV4_WITH_PORT_RE.test(text)) return normalizeIp(text);

  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(text);
  if (match) {
    if (match[2] !== undefined && !isValidPort(match[2])) return null;
    return parseIpv4(match[1]);
  }
  return normalizeIp(text);
}

function isValidPort(raw: string): boolean {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535;
}

/** Stable, non-reversible identity stored in the database. */
export function hashIp(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/** Constant-time comparison used by tests to compare hashes. */
export function hashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
