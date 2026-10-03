import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { route } from "../api/stats.js";
import { setDbForTests, type Sql } from "../lib/db.js";

/**
 * The stats endpoint is the only route that reads across every visitor's rows,
 * so its gate is tested rather than assumed: unset must mean *off*, not "open",
 * and a wrong token must not be distinguishable from a right one by shape.
 */

const TOKEN = "s".repeat(32);
const saved = process.env.STATS_TOKEN;

afterEach(() => {
  if (saved === undefined) delete process.env.STATS_TOKEN;
  else process.env.STATS_TOKEN = saved;
  setDbForTests(null);
});

/**
 * Minimal stand-in, keyed on a marker unique to each query. Matching on
 * something vague like `status = 'failed'` would also hit the window query and
 * silently hand back the wrong shape.
 */
function fakeDb(): Sql {
  return ((strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    if (sql.includes("with w(label, since)")) {
      return Promise.resolve([
        { label: "today", networks: 2, attempts: 4, succeeded: 3, failed: 1 },
        { label: "last7", networks: 5, attempts: 9, succeeded: 7, failed: 2 },
        { label: "last30", networks: 8, attempts: 14, succeeded: 11, failed: 3 },
      ]);
    }
    if (sql.includes("count(distinct client_ip_hash)")) {
      return Promise.resolve([
        {
          attempts: 14,
          succeeded: 11,
          failed: 3,
          networks: 8,
          // Postgres returns numeric/aggregate columns as strings.
          estimated_cost: "0.8800",
          avg_latency: "15400.5",
          max_latency: 20300,
          first_at: "2026-10-03T10:00:00.000Z",
          last_at: "2026-10-03T12:00:00.000Z",
        },
      ]);
    }
    if (sql.includes("group by npc_id")) {
      return Promise.resolve([{ npc_id: "rose", attempts: 4, succeeded: 3, failed: 1 }]);
    }
    if (sql.includes("as error_type")) {
      return Promise.resolve([{ error_type: "provider_error", count: 1 }]);
    }
    if (sql.includes("as source")) {
      return Promise.resolve([{ source: "(direct)", count: 4 }]);
    }
    throw new Error(`fakeDb: unmatched query: ${sql.slice(0, 60)}`);
  }) as unknown as Sql;
}

function get(query = "", headers: Record<string, string> = {}): Request {
  return new Request(`https://example.test/api/stats${query}`, { headers });
}

describe("stats endpoint gate", () => {
  test("is off — 404, not open — when STATS_TOKEN is unset", async () => {
    delete process.env.STATS_TOKEN;
    setDbForTests(fakeDb());
    const res = await route(get("?token=anything"));
    assert.equal(res.status, 404);
  });

  test("treats a too-short token as no token at all", async () => {
    process.env.STATS_TOKEN = "short";
    setDbForTests(fakeDb());
    assert.equal((await route(get("?token=short"))).status, 404);
  });

  test("401s a wrong token, a missing token and an empty one alike", async () => {
    process.env.STATS_TOKEN = TOKEN;
    setDbForTests(fakeDb());
    for (const q of ["", "?token=", "?token=wrong", `?token=${"s".repeat(31)}`]) {
      assert.equal((await route(get(q))).status, 401, q);
    }
  });

  test("accepts the token in the query string or as a bearer header", async () => {
    process.env.STATS_TOKEN = TOKEN;
    setDbForTests(fakeDb());
    assert.equal((await route(get(`?token=${TOKEN}`))).status, 200);
    assert.equal((await route(get("", { authorization: `Bearer ${TOKEN}` }))).status, 200);
  });

  test("refuses non-GET methods", async () => {
    process.env.STATS_TOKEN = TOKEN;
    setDbForTests(fakeDb());
    const res = await route(new Request("https://example.test/api/stats", { method: "POST" }));
    assert.equal(res.status, 405);
  });

  test("sends no CORS headers, so a cross-origin page cannot read the body", async () => {
    process.env.STATS_TOKEN = TOKEN;
    setDbForTests(fakeDb());
    const res = await route(get(`?token=${TOKEN}`, { origin: "https://evil.example.com" }));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("stats payload", () => {
  test("reports aggregates and never an identifier", async () => {
    process.env.STATS_TOKEN = TOKEN;
    setDbForTests(fakeDb());
    const body = await (await route(get(`?token=${TOKEN}`))).json();

    assert.equal(body.ok, true);
    assert.equal(body.stats.windows.today.networks, 2);
    assert.equal(body.stats.windows.today.attempts, 4);
    assert.equal(body.stats.windows.last30.networks, 8);
    assert.equal(body.stats.allTime.networks, 8);
    // numeric columns arrive as strings from Postgres and must be coerced
    assert.equal(body.stats.allTime.estimatedCost, 0.88);
    assert.equal(body.stats.allTime.avgLatencyMs, 15401);
    assert.deepEqual(body.stats.byNpc, [{ npcId: "rose", attempts: 4, succeeded: 3, failed: 1 }]);
    assert.deepEqual(body.stats.sources, [{ source: "(direct)", count: 4 }]);
    assert.deepEqual(body.stats.failures, [{ errorType: "provider_error", count: 1 }]);
    assert.equal(body.stats.allTime.firstAt, "2026-10-03T10:00:00.000Z");

    const serialized = JSON.stringify(body);
    for (const forbidden of ["ip_hash", "client_id", "ipHash", "clientId"]) {
      assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
    }
  });
});
