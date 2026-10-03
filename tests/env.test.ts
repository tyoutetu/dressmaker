import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { corsHeaders, isOriginAllowed } from "../lib/env.js";

/**
 * The origin allowlist is the one thing standing between a browser and the paid
 * generation endpoint, so its rules are pinned here rather than inferred.
 *
 * The case that matters most is the last group: with the site and its functions
 * in one Vercel project, the browser's own `Origin` header names the deployment
 * itself. Rejecting it — which an unset `ALLOWED_ORIGINS` used to do — would 403
 * every request on the very arrangement the project is built around.
 */

const TOUCHED = [
  "ALLOWED_ORIGINS",
  "ALLOW_ALL_ORIGINS",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

const saved = new Map(TOUCHED.map((key) => [key, process.env[key]]));

function reset(): void {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(reset);

describe("origin allowlist", () => {
  test("allows non-browser clients, which send no Origin at all", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    assert.equal(isOriginAllowed(null), true);
  });

  test("allows the local development origins without configuration", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    for (const origin of ["http://localhost:5173", "http://localhost:4173", "http://127.0.0.1:3000"]) {
      assert.equal(isOriginAllowed(origin), true, origin);
    }
  });

  test("refuses an unrelated site when nothing is configured", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOW_ALL_ORIGINS;
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    assert.equal(isOriginAllowed("https://evil.example.com"), false);
  });

  test("honours an explicit ALLOWED_ORIGINS list, trailing slash and all", () => {
    reset();
    process.env.ALLOWED_ORIGINS = "https://one.example.com, https://two.example.com/";
    assert.equal(isOriginAllowed("https://one.example.com"), true);
    assert.equal(isOriginAllowed("https://two.example.com"), true);
    assert.equal(isOriginAllowed("https://three.example.com"), false);
  });

  test("ALLOW_ALL_ORIGINS is an explicit, deliberate escape hatch", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    process.env.ALLOW_ALL_ORIGINS = "true";
    assert.equal(isOriginAllowed("https://anywhere.example.com"), true);
    process.env.ALLOW_ALL_ORIGINS = "false";
    assert.equal(isOriginAllowed("https://anywhere.example.com"), false);
  });

  test("accepts this deployment's own origin, so one project needs no configuration", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOW_ALL_ORIGINS;
    process.env.VERCEL_URL = "dressmaker-abc123.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "dressmaker-rouge.vercel.app";

    // The production alias, a preview hostname, and the same host over https.
    assert.equal(isOriginAllowed("https://dressmaker-rouge.vercel.app"), true);
    assert.equal(isOriginAllowed("https://dressmaker-abc123.vercel.app"), true);
    // A neighbouring project on the same platform is still somebody else.
    assert.equal(isOriginAllowed("https://someone-elses-app.vercel.app"), false);
  });

  test("echoes the origin back only when it is allowed", () => {
    reset();
    delete process.env.ALLOWED_ORIGINS;
    process.env.VERCEL_URL = "dressmaker-abc123.vercel.app";

    assert.equal(
      corsHeaders("https://dressmaker-abc123.vercel.app")["Access-Control-Allow-Origin"],
      "https://dressmaker-abc123.vercel.app",
    );
    assert.equal(
      corsHeaders("https://evil.example.com")["Access-Control-Allow-Origin"],
      undefined,
    );
    // Always present, so a cache never serves one origin's response to another.
    assert.equal(corsHeaders(null).Vary, "Origin");
  });
});
