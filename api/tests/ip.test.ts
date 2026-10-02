import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashIp, normalizeIp, parseTrustedAddress, resolveClientIp } from "../lib/ip";

describe("IP normalization", () => {
  test("canonicalizes strict IPv4 and rejects malformed input", () => {
    assert.equal(normalizeIp("203.0.113.7")?.canonical, "203.0.113.7");
    assert.equal(normalizeIp("  203.0.113.7  ")?.canonical, "203.0.113.7");
    assert.equal(normalizeIp("203.0.113.007")?.canonical, "203.0.113.7");
    assert.equal(normalizeIp("0.0.0.0")?.canonical, "0.0.0.0");

    for (const bad of ["203.0.113.256", "203.0.113", "1.2.3.4.5", "abc", "", "1.2.3.-4", "1.2.3.4/24"]) {
      assert.equal(normalizeIp(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test("canonicalizes equivalent IPv6 spellings to one identity", () => {
    const short = normalizeIp("2001:DB8::1");
    const long = normalizeIp("2001:db8:0:0:0:0:0:1");
    assert.equal(short?.family, 6);
    assert.equal(short?.canonical, "2001:db8::1");
    assert.equal(long?.canonical, short?.canonical);

    assert.equal(normalizeIp("FE80:0000:0000:0000:0000:0000:0000:0001")?.canonical, "fe80::1");
    assert.equal(normalizeIp("[2001:db8::1]")?.canonical, "2001:db8::1");
  });

  test("collapses every equivalent IPv4-mapped form onto one IPv4 identity", () => {
    for (const mapped of [
      "::ffff:192.0.2.128",
      "::FFFF:C000:0280",
      "::ffff:c000:280",
      // The full, uncompressed mapped form used to be rejected outright.
      "0:0:0:0:0:ffff:192.0.2.128",
      "0:0:0:0:0:FFFF:C000:0280",
      "0000:0000:0000:0000:0000:ffff:c000:0280",
    ]) {
      const parsed = normalizeIp(mapped);
      assert.equal(parsed?.family, 4, `${mapped} should fold to IPv4`);
      assert.equal(parsed?.canonical, "192.0.2.128");
    }
  });

  test("rejects zone ids, malformed brackets, ports and address lists", () => {
    for (const bad of [
      "fe80::1%en0",
      "fe80::1%25eth0",
      "[2001:db8::1",
      "2001:db8::1]",
      "[]",
      "[1.2.3.4]",
      "1.2.3.4,5.6.7.8",
      "1.2.3.4:443",
      "1.2.3.4:99999",
    ]) {
      assert.equal(normalizeIp(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test("does not mistake ::, ::1 or other IPv6 addresses for IPv4", () => {
    assert.equal(normalizeIp("::")?.canonical, "::");
    assert.equal(normalizeIp("::")?.family, 6);
    assert.equal(normalizeIp("::1")?.canonical, "::1");
    assert.equal(normalizeIp("::1")?.family, 6);
    assert.equal(normalizeIp("::2")?.family, 6);
  });

  test("rejects malformed IPv6", () => {
    for (const bad of ["2001:db8:::1", "12345::1", "1:2:3:4:5:6:7:8:9", "2001:db8::g", "::ffff:999.0.0.1"]) {
      assert.equal(normalizeIp(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe("trusted client IP resolution", () => {
  test("accepts the platform header on Vercel", () => {
    const headers = new Headers({ "x-vercel-forwarded-for": "198.51.100.9" });
    const result = resolveClientIp(headers, { isVercel: true, localMode: false });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.ip.canonical, "198.51.100.9");
  });

  test("takes the first entry of a forwarded list", () => {
    const headers = new Headers({ "x-vercel-forwarded-for": "198.51.100.9, 10.0.0.1" });
    const result = resolveClientIp(headers, { isVercel: true, localMode: false });
    assert.equal(result.ok && result.ip.canonical, "198.51.100.9");
  });

  test("ignores spoofable headers entirely", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
      forwarded: "for=9.9.9.9",
      "x-client-ip": "10.10.10.10",
    });
    const result = resolveClientIp(headers, { isVercel: true, localMode: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "trusted_ip_missing");
  });

  test("fails closed when the platform header is malformed", () => {
    for (const bad of [
      "not-an-ip",
      "198.51.100.9:99999",
      "198.51.100.9:port",
      "[2001:db8::1",
      "fe80::1%en0",
    ]) {
      const result = resolveClientIp(new Headers({ "x-vercel-forwarded-for": bad }), {
        isVercel: true,
        localMode: false,
      });
      assert.equal(result.ok, false, `expected ${bad} to fail closed`);
      assert.equal(result.ok === false && result.reason, "trusted_ip_invalid");
    }
  });

  test("accepts a valid port, but never reads one out of a bare IPv6 address", () => {
    assert.equal(parseTrustedAddress("203.0.113.7:8443")?.canonical, "203.0.113.7");
    assert.equal(parseTrustedAddress("[2001:db8::1]:8443")?.canonical, "2001:db8::1");
    assert.equal(parseTrustedAddress("[::ffff:192.0.2.1]:443")?.canonical, "192.0.2.1");
    // Colons inside a bare IPv6 literal are part of the address.
    assert.equal(parseTrustedAddress("2001:db8::1")?.canonical, "2001:db8::1");
    assert.equal(parseTrustedAddress("203.0.113.7:0")?.canonical, "203.0.113.7");
  });

  test("folds a full mapped header onto the plain IPv4 quota identity", () => {
    const mapped = resolveClientIp(
      new Headers({ "x-vercel-forwarded-for": "0:0:0:0:0:ffff:198.51.100.9" }),
      { isVercel: true, localMode: false },
    );
    const plain = resolveClientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.9" }), {
      isVercel: true,
      localMode: false,
    });
    assert.equal(mapped.ok, true);
    assert.equal(plain.ok, true);
    if (!mapped.ok || !plain.ok) return;
    assert.equal(mapped.ip.family, 4);
    assert.equal(mapped.ip.canonical, plain.ip.canonical);
  });

  test("never falls back to local mode on the Vercel platform", () => {
    const result = resolveClientIp(new Headers(), { isVercel: true, localMode: true });
    assert.equal(result.ok, false);
  });

  test("fails closed off-platform unless local mode is explicitly enabled", () => {
    const denied = resolveClientIp(new Headers(), { isVercel: false, localMode: false });
    assert.equal(denied.ok, false);

    const allowed = resolveClientIp(new Headers(), { isVercel: false, localMode: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ok && allowed.source, "local");
    assert.equal(allowed.ok && allowed.ip.canonical, "127.0.0.1");
  });
});

describe("quota hashing", () => {
  test("is stable, secret-dependent and never equals the raw address", () => {
    const a = hashIp("203.0.113.7", "secret-one-long-enough");
    const b = hashIp("203.0.113.7", "secret-one-long-enough");
    const other = hashIp("203.0.113.7", "secret-two-long-enough");
    const otherIp = hashIp("203.0.113.8", "secret-one-long-enough");

    assert.equal(a, b);
    assert.notEqual(a, other);
    assert.notEqual(a, otherIp);
    assert.ok(!a.includes("203.0.113.7"));
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});
