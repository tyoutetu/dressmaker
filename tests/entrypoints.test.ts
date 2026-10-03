import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import generateDefault, { route as generate } from "../api/generate.js";
import quotaDefault, { route as quota } from "../api/quota.js";
import feedbackDefault, { route as feedback } from "../api/feedback.js";
import healthDefault, { route as health } from "../api/health.js";

/**
 * Vercel's current documented Node.js runtime shape is a Web-standard function:
 * a named export that takes a `Request` and returns a `Response`, plus a default
 * export of `{ fetch }`. The suite calls the named route directly, and this file
 * pins the default export to the same function so a deployment cannot drift.
 */

describe("Vercel Web-standard entrypoints", () => {
  const routes = [
    ["generate", generate, generateDefault],
    ["quota", quota, quotaDefault],
    ["feedback", feedback, feedbackDefault],
    ["health", health, healthDefault],
  ] as const;

  test("every API file exports a named route wrapped by default { fetch }", () => {
    for (const [name, named, defaultExport] of routes) {
      assert.equal(typeof named, "function", `${name} must export a named route function`);
      const fetch = (defaultExport as { fetch?: unknown }).fetch;
      assert.equal(typeof fetch, "function", `${name} default export must expose fetch`);
      assert.equal(fetch, named, `${name} default fetch must be the named route`);
    }
  });

  test("the obsolete custom Node/Web bridge is gone", () => {
    assert.equal(existsSync(new URL("../lib/http.ts", import.meta.url)), false);
  });
});
