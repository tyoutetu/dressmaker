import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readQuotaCounters, reserveQuota } from "../lib/db.js";
import { hashIp, resolveClientIp } from "../lib/ip.js";
import { utcDayKey, nextUtcReset, buildQuotaSnapshot } from "../lib/quota.js";
import { createTestDb, neonLike, type TestDb } from "./helpers.js";

/**
 * These tests run the real api/sql/schema.sql on embedded Postgres, so the
 * reservation function exercised here is the same one production calls.
 */

const SECRET = "test-secret-at-least-16-chars";
const ipHash = (ip: string) => hashIp(ip, SECRET);

describe("reserve_generation_quota (Postgres semantics)", () => {
  let db: TestDb;

  before(async () => {
    db = await createTestDb();
  });

  after(async () => {
    await db.close();
  });

  test("a burst of 20 concurrent requests from one network yields exactly 3", async () => {
    const day = "2026-01-01";
    const identity = ipHash("198.51.100.10");

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, day),
      ),
    );

    const allowed = results.filter((result) => result.allowed);
    assert.equal(allowed.length, 3);
    assert.equal(allowed[0].userCount, 1);
    assert.equal(allowed[2].userCount, 3);
    assert.equal(results.filter((r) => r.reason === "user_limit").length, 17);

    const counters = await readQuotaCounters(db.sql, identity, day);
    assert.equal(counters.userCount, 3);
    assert.equal(counters.globalCount, 3);
  });

  test("the global ceiling stops unrelated networks", async () => {
    const day = "2026-01-02";
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        reserveQuota(db.sql, ipHash(`203.0.113.${n}`), { userLimit: 3, globalLimit: 2 }, day),
      ),
    );

    assert.equal(results.filter((r) => r.allowed).length, 2);
    assert.equal(results.filter((r) => r.reason === "global_limit").length, 3);
    const counters = await readQuotaCounters(db.sql, ipHash("203.0.113.1"), day);
    assert.equal(counters.globalCount, 2);
  });

  test("counters roll over with the UTC day", async () => {
    const identity = ipHash("198.51.100.20");
    for (let i = 0; i < 3; i++) {
      const result = await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, "2026-02-01");
      assert.equal(result.allowed, true);
    }
    const blocked = await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, "2026-02-01");
    assert.equal(blocked.allowed, false);

    const nextDay = await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, "2026-02-02");
    assert.equal(nextDay.allowed, true);
    assert.equal(nextDay.userCount, 1);
  });

  test("a new browser id from the same network cannot reset the quota", async () => {
    const day = "2026-03-01";
    const identity = ipHash("198.51.100.30");
    for (let i = 0; i < 3; i++) {
      await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, day);
    }

    // The browser id only ever lands in `generations`; it is not an input to the
    // quota at all, so a cleared localStorage cannot buy another paid attempt.
    await db.sql`
      insert into generations (client_id, client_ip_hash, npc_id, status, counted)
      values ('fresh-browser-id', ${identity}, 'rose', 'success', true)
    `;
    const blocked = await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 100 }, day);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "user_limit");
  });

  test("IPv6 spellings of the same host share one quota", async () => {
    const day = "2026-03-02";
    const canonicalHash = (header: string): string => {
      const resolved = resolveClientIp(new Headers({ "x-vercel-forwarded-for": header }), {
        isVercel: true,
        localMode: false,
      });
      assert.equal(resolved.ok, true, `expected ${header} to resolve`);
      return hashIp(resolved.ok ? resolved.ip.canonical : "", SECRET);
    };

    const short = canonicalHash("2001:DB8::5");
    const long = canonicalHash("2001:db8:0:0:0:0:0:5");
    assert.equal(long, short);

    for (let i = 0; i < 3; i++) {
      const result = await reserveQuota(db.sql, short, { userLimit: 3, globalLimit: 100 }, day);
      assert.equal(result.allowed, true);
    }
    const blocked = await reserveQuota(db.sql, long, { userLimit: 3, globalLimit: 100 }, day);
    assert.equal(blocked.allowed, false);
  });

  test("a zero ceiling disables paid generation without touching counters", async () => {
    const day = "2026-04-01";
    const identity = ipHash("198.51.100.40");

    const userZero = await reserveQuota(db.sql, identity, { userLimit: 0, globalLimit: 100 }, day);
    assert.equal(userZero.allowed, false);
    assert.equal(userZero.reason, "disabled");

    const globalZero = await reserveQuota(db.sql, identity, { userLimit: 3, globalLimit: 0 }, day);
    assert.equal(globalZero.allowed, false);
    assert.equal(globalZero.reason, "disabled");

    const counters = await readQuotaCounters(db.sql, identity, day);
    assert.equal(counters.userCount, 0);
    assert.equal(counters.globalCount, 0);
  });

  test("a missing or truncated identity is refused rather than shared", async () => {
    const result = await reserveQuota(db.sql, "", { userLimit: 3, globalLimit: 100 }, "2026-05-01");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "invalid_identity");
  });
});

describe("quota window helpers", () => {
  test("schema.sql can be applied more than once (db:init is safe to re-run)", async () => {
    const db = await createTestDb();
    try {
      const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
      await db.pglite.exec(schema);
      const allowed = await reserveQuota(db.sql, ipHash("198.51.100.99"), { userLimit: 3, globalLimit: 100 }, "2026-06-01");
      assert.equal(allowed.allowed, true);
    } finally {
      await db.close();
    }
  });

  test("the reset instant is the next UTC midnight", () => {
    const now = new Date("2026-10-02T13:45:30.000Z");
    assert.equal(utcDayKey(now), "2026-10-02");
    const reset = nextUtcReset(now);
    assert.equal(reset.iso, "2026-10-03T00:00:00.000Z");
    assert.equal(reset.secondsRemaining, 10 * 3600 + 14 * 60 + 30);
  });

  test("the snapshot reports remaining previews and the reset instant", () => {
    const snapshot = buildQuotaSnapshot(
      { userLimit: 3, globalLimit: 100 },
      2,
      new Date("2026-10-02T00:00:00Z"),
      2,
    );
    assert.equal(snapshot.limit, 3);
    assert.equal(snapshot.used, 2);
    assert.equal(snapshot.remaining, 1);
    assert.equal(snapshot.network_remaining, 1);
    assert.equal(snapshot.global_remaining, 98);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.variant, "ok");
    assert.equal(snapshot.scope, "network");
    assert.equal(snapshot.disabled, false);
    assert.equal(snapshot.reset_at, "2026-10-03T00:00:00.000Z");
  });

  test("the global ceiling makes the snapshot unavailable without blaming the visitor", () => {
    // The visitor has only used one of their own three attempts, but the shared
    // budget for the day is gone: remaining must be 0 and the variant must say
    // "global", never "network".
    const snapshot = buildQuotaSnapshot(
      { userLimit: 3, globalLimit: 100 },
      1,
      new Date("2026-10-02T00:00:00Z"),
      100,
    );
    assert.equal(snapshot.remaining, 0);
    assert.equal(snapshot.variant, "global");
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.network_remaining, 2, "personal headroom is still reported");
    assert.equal(snapshot.global_remaining, 0);
    assert.equal(snapshot.used, 1);
  });

  test("the network ceiling is reported as the network variant", () => {
    const snapshot = buildQuotaSnapshot(
      { userLimit: 3, globalLimit: 100 },
      3,
      new Date("2026-10-02T00:00:00Z"),
      3,
    );
    assert.equal(snapshot.remaining, 0);
    assert.equal(snapshot.variant, "network");
    assert.equal(snapshot.available, false);
  });

  test("a zero limit is reported as disabled", () => {
    const snapshot = buildQuotaSnapshot({ userLimit: 0, globalLimit: 100 }, 0);
    assert.equal(snapshot.disabled, true);
    assert.equal(snapshot.remaining, 0);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.variant, "disabled");
  });
});

describe("schema migrations", () => {
  const LEGACY_SCHEMA = `
    create table usage_daily (
      usage_date   date not null,
      anonymous_id varchar(64) not null,
      count        integer not null default 0,
      primary key (usage_date, anonymous_id)
    );
    create table generations (
      id           uuid primary key default gen_random_uuid(),
      anonymous_id varchar(64) not null,
      npc_id       varchar(64) not null,
      status       varchar(16) not null,
      created_at   timestamptz not null default now()
    );
    insert into usage_daily (usage_date, anonymous_id, count) values ('2026-01-01', 'browser-a', 2);
    insert into usage_daily (usage_date, anonymous_id, count) values ('2026-01-01', 'browser-b', 3);
    insert into generations (anonymous_id, npc_id, status) values ('browser-a', 'rose', 'success');
  `;

  test("an old browser-id schema is renamed aside, not destroyed", async () => {
    const pglite = new PGlite();
    const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
    try {
      await pglite.exec(LEGACY_SCHEMA);

      // First application: the old table and its rows must survive under a new name.
      await pglite.exec(schema);
      const legacy = await pglite.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = current_schema() and table_name like 'usage_daily_legacy_%'`,
      );
      assert.equal(legacy.rows.length, 1, "exactly one legacy table is kept");
      const legacyName = legacy.rows[0].table_name;

      const preserved = await pglite.query<{ n: number }>(
        `select count(*)::int as n from ${legacyName}`,
      );
      assert.equal((preserved.rows[0] as { n: number }).n, 2, "legacy metadata is not destroyed");

      const renamed = await pglite.query<{ anonymous_id: string }>(
        `select anonymous_id from ${legacyName} order by anonymous_id`,
      );
      assert.deepEqual(
        renamed.rows.map((row) => row.anonymous_id),
        ["browser-a", "browser-b"],
      );

      // The new table is keyed by ip_hash and starts empty: browser ids are never
      // migrated into IP hashes.
      const fresh = await pglite.query<{ n: number }>(
        `select count(*)::int as n from usage_daily`,
      );
      assert.equal((fresh.rows[0] as { n: number }).n, 0);
      const columns = await pglite.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'usage_daily'`,
      );
      assert.ok(columns.rows.some((row) => row.column_name === "ip_hash"));
      assert.ok(!columns.rows.some((row) => row.column_name === "anonymous_id"));
    } finally {
      await pglite.close();
    }
  });

  test("applying the schema twice never renames or loses the legacy table", async () => {
    const pglite = new PGlite();
    const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
    try {
      await pglite.exec(LEGACY_SCHEMA);
      await pglite.exec(schema);
      await pglite.exec(schema);

      const legacy = await pglite.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = current_schema() and table_name like 'usage_daily_legacy_%'`,
      );
      assert.equal(legacy.rows.length, 1, "a second run must not add another legacy table");
      const preserved = await pglite.query<{ n: number }>(
        `select count(*)::int as n from ${legacy.rows[0].table_name}`,
      );
      assert.equal((preserved.rows[0] as { n: number }).n, 2);

      const sql = neonLike(pglite);
      const allowed = await reserveQuota(sql, ipHash("198.51.100.99"), { userLimit: 3, globalLimit: 100 }, "2026-06-01");
      assert.equal(allowed.allowed, true);
    } finally {
      await pglite.close();
    }
  });

  test("an empty database stays clean: no legacy table is invented", async () => {
    const db = await createTestDb();
    try {
      const legacy = await db.pglite.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = current_schema() and table_name like 'usage_daily_legacy_%'`,
      );
      assert.equal(legacy.rows.length, 0);
    } finally {
      await db.close();
    }
  });
});
