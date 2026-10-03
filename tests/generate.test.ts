import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { route as generate } from "../api/generate";
import { route as quotaEndpoint } from "../api/quota";
import { route as health } from "../api/health";
import { setDbForTests } from "../lib/db";
import { ApiError } from "../lib/errors";
import { setProviderForTests } from "../lib/provider";
import {
  createTestDb,
  fakeProvider,
  generateForm,
  tinyJpeg,
  withEnv,
  type FakeProvider,
  type TestDb,
} from "./helpers";

const SECRET = "test-secret-at-least-16-chars";
const TRUSTED = { "x-vercel-forwarded-for": "198.51.100.50" };

interface Harness {
  db: TestDb;
  provider: FakeProvider;
  close(): Promise<void>;
}

/**
 * Each test gets a fresh embedded Postgres and a fake provider, so the real
 * handlers run end to end without a paid API call.
 */
async function harness(options: {
  provider?: FakeProvider;
  env?: Record<string, string | undefined>;
} = {}): Promise<Harness> {
  const db = await createTestDb();
  const provider = options.provider ?? fakeProvider();
  setDbForTests(db.sql);
  setProviderForTests(provider);

  const env: Record<string, string | undefined> = {
    VERCEL: "1",
    IP_HASH_SECRET: SECRET,
    ALLOW_LOCAL_QUOTA_MODE: undefined,
    USER_DAILY_GENERATION_LIMIT: "3",
    GLOBAL_DAILY_GENERATION_LIMIT: "100",
    AI_PROVIDER: "qwen",
    DASHSCOPE_API_KEY: undefined,
    DATABASE_URL: undefined,
    ...(options.env ?? {}),
  };
  for (const key of Object.keys(env)) {
    // Apply for the lifetime of the harness; tests that need different values
    // wrap the call in withEnv instead.
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    db,
    provider,
    async close() {
      setDbForTests(null);
      setProviderForTests(null);
      await db.close();
    },
  };
}

async function post(body: Record<string, string | Blob>, headers: Record<string, string> = {}) {
  return (await generate(generateForm(body, { ...TRUSTED, ...headers }))) as Response;
}

async function validForm(extra: Record<string, string | Blob> = {}) {
  return { npc_id: "rose", image: new File([new Uint8Array(await tinyJpeg())], "dress.jpg", { type: "image/jpeg" }), ...extra };
}

describe("POST /api/generate", () => {
  test("rejects an incomplete request before anything is charged", async () => {
    const h = await harness();
    try {
      const response = await post({ npc_id: "rose" });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, "bad_request");
      assert.equal(body.details.counted, false);
      assert.equal(h.provider.calls, 0);
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0);
    } finally {
      await h.close();
    }
  });

  test("rejects a customer that ships no artwork", async () => {
    const h = await harness();
    try {
      const response = await post({ npc_id: "dorothy", image: new File([new Uint8Array(await tinyJpeg())], "d.jpg", { type: "image/jpeg" }) });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_npc");
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("rejects an unusable image before reserving quota", async () => {
    const h = await harness();
    try {
      const response = await post({
        npc_id: "rose",
        image: new File([new Uint8Array(Buffer.from("not an image"))], "fake.png", { type: "image/png" }),
      });
      assert.equal(response.status, 415);
      assert.equal((await response.json()).error, "invalid_image");
      assert.equal(h.provider.calls, 0);
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0);
    } finally {
      await h.close();
    }
  });

  test("fails closed when the hashing secret is missing", async () => {
    const h = await harness({ env: { IP_HASH_SECRET: undefined } });
    try {
      const response = await post(await validForm());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "service_unavailable");
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("fails closed when no trusted client address is present", async () => {
    const h = await harness();
    try {
      const response = (await generate(
        generateForm({ ...(await validForm()) }, { "x-vercel-forwarded-for": "", "x-forwarded-for": "1.2.3.4" }),
      )) as Response;
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "service_unavailable");
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("fails closed when the database is unreachable (no paid call)", async () => {
    const h = await harness();
    try {
      const broken = (() => {
        throw new Error("connection refused");
      }) as never;
      setDbForTests(broken);
      const response = await post(await validForm());
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, "quota_unavailable");
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("fails closed when the provider key is missing (no quota consumed)", async () => {
    const h = await harness();
    try {
      setProviderForTests(null);
      const response = await post(await validForm());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "service_unavailable");
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0);
    } finally {
      await h.close();
    }
  });

  test("returns a bounded PNG preview with quota information", async () => {
    const h = await harness();
    try {
      const response = await post(await validForm());
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.match(body.image, /^data:image\/png;base64,/);
      assert.equal(body.mock, false);
      assert.equal(body.provider, "fake");
      assert.equal(body.quota.limit, 3);
      assert.equal(body.quota.used, 1);
      assert.equal(body.quota.remaining, 2);
      assert.equal(body.quota.scope, "network");
      assert.ok(Date.parse(body.quota.reset_at) > Date.now());
      assert.match(body.generation_id, /^[0-9a-f-]{36}$/);
      assert.equal(h.provider.calls, 1);
      assert.equal(h.provider.lastReferenceMime, "image/png");

      const rows = await h.db.pglite.query("select status, counted from generations");
      assert.deepEqual(rows.rows, [{ status: "success", counted: true }]);
    } finally {
      await h.close();
    }
  });

  test("allows exactly 3 paid attempts, then reports the reset instant", async () => {
    const h = await harness();
    try {
      for (let i = 1; i <= 3; i++) {
        const response = await post(await validForm());
        assert.equal(response.status, 200, `attempt ${i} should succeed`);
        assert.equal((await response.json()).quota.remaining, 3 - i);
      }

      const blocked = await post(await validForm());
      const body = await blocked.json();
      assert.equal(blocked.status, 429);
      assert.equal(body.error, "limit_reached");
      assert.equal(body.details.variant, "network");
      assert.equal(body.details.counted, false);
      assert.equal(body.details.quota.remaining, 0);
      assert.ok(body.details.quota.reset_at);
      assert.equal(h.provider.calls, 3, "the blocked attempt must not reach the provider");
    } finally {
      await h.close();
    }
  });

  test("counts an attempt that was dispatched even when it fails (no refund)", async () => {
    const failing = fakeProvider({ fail: new ApiError("timeout", 504, "upstream timed out") });
    const h = await harness({ provider: failing, env: { USER_DAILY_GENERATION_LIMIT: "2" } });
    try {
      const failed = await post(await validForm());
      const failedBody = await failed.json();
      assert.equal(failed.status, 504);
      assert.equal(failedBody.error, "timeout");
      assert.equal(failedBody.details.counted, true);
      assert.equal(failedBody.details.quota.used, 1);
      assert.equal(failedBody.details.quota.remaining, 1);

      const retry = await post(await validForm());
      assert.equal((await retry.json()).details.quota.used, 2);

      const exhausted = await post(await validForm());
      assert.equal(exhausted.status, 429);
      assert.equal(failing.calls, 2, "the failed attempt is not refunded");

      const rows = await h.db.pglite.query("select status, error_type, counted from generations order by created_at");
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(rows.rows[0], { status: "failed", error_type: "timeout", counted: true });
    } finally {
      await h.close();
    }
  });

  test("spoofed client headers cannot widen the quota", async () => {
    const h = await harness();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await post(await validForm(), {
          // Same trusted address on Vercel, arbitrary client-controlled values.
          "x-forwarded-for": `10.0.0.${i}`,
          "x-real-ip": `10.1.0.${i}`,
          forwarded: `for=10.2.0.${i}`,
        });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 429]);
      assert.equal(h.provider.calls, 3);
    } finally {
      await h.close();
    }
  });

  test("a fresh browser id from the same network does not reset the quota", async () => {
    const h = await harness({ env: { USER_DAILY_GENERATION_LIMIT: "1" } });
    try {
      const first = await post({ ...(await validForm()), client_id: "browser-a" });
      assert.equal(first.status, 200);
      const second = await post({ ...(await validForm()), client_id: "browser-b" });
      assert.equal(second.status, 429);
    } finally {
      await h.close();
    }
  });

  test("a zero global ceiling disables paid generation for everyone", async () => {
    const h = await harness({ env: { GLOBAL_DAILY_GENERATION_LIMIT: "0" } });
    try {
      const response = await post(await validForm());
      const body = await response.json();
      assert.equal(response.status, 429);
      assert.equal(body.details.variant, "disabled");
      assert.equal(body.details.counted, false);
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("a malformed limit fails closed instead of defaulting open", async () => {
    const h = await harness({ env: { GLOBAL_DAILY_GENERATION_LIMIT: "unlimited" } });
    try {
      const response = await post(await validForm());
      assert.equal(response.status, 503);
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("refuses a USER_DAILY_GENERATION_LIMIT above the sanity ceiling", async () => {
    const h = await harness({ env: { USER_DAILY_GENERATION_LIMIT: "101" } });
    try {
      const response = await post(await validForm());
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, "service_unavailable");
      assert.equal(body.details.counted, false);
      assert.equal(h.provider.calls, 0, "a misconfigured ceiling must not reach the provider");
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0);
    } finally {
      await h.close();
    }
  });

  test("a zero per-network ceiling disables generation without touching counters", async () => {
    const h = await harness({ env: { USER_DAILY_GENERATION_LIMIT: "0" } });
    try {
      const response = await post(await validForm());
      const body = await response.json();
      assert.equal(response.status, 429);
      assert.equal(body.details.variant, "disabled");
      assert.equal(body.details.counted, false);
      assert.equal(body.details.quota.remaining, 0);
      assert.equal(h.provider.calls, 0);
    } finally {
      await h.close();
    }
  });

  test("refuses an oversized request body before validation or the provider", async () => {
    const h = await harness();
    try {
      const huge = new File([new Uint8Array(5 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" });
      const response = await post({ npc_id: "rose", image: huge });
      const body = await response.json();
      assert.equal(response.status, 413);
      assert.equal(body.error, "invalid_image");
      assert.equal(body.details.counted, false);
      assert.equal(h.provider.calls, 0);
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0);

      // A normal multipart upload must still work right after the rejection.
      const ok = await post(await validForm());
      assert.equal(ok.status, 200);
      assert.equal(h.provider.calls, 1);
    } finally {
      await h.close();
    }
  });
});

describe("GET /api/quota", () => {
  test("reports remaining previews without reserving anything", async () => {
    const h = await harness();
    try {
      const request = new Request("http://localhost:3000/api/quota", { headers: TRUSTED });
      const response = (await quotaEndpoint(request)) as Response;
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.quota.remaining, 3);
      assert.equal(body.quota.used, 0);
      const counters = await h.db.pglite.query("select count(*)::int as n from usage_daily");
      assert.equal((counters.rows[0] as { n: number }).n, 0, "reading quota must not consume it");
    } finally {
      await h.close();
    }
  });

  test("fails closed when the trusted address is missing", async () => {
    const h = await harness();
    try {
      const request = new Request("http://localhost:3000/api/quota");
      const response = (await quotaEndpoint(request)) as Response;
      assert.equal(response.status, 503);
    } finally {
      await h.close();
    }
  });

  test("reports a spent global budget without pretending the visitor used their own", async () => {
    const h = await harness({ env: { GLOBAL_DAILY_GENERATION_LIMIT: "2" } });
    try {
      // Two different networks consume the shared budget for the day.
      for (const ip of ["198.51.100.61", "198.51.100.62"]) {
        const response = await post(await validForm(), { "x-vercel-forwarded-for": ip });
        assert.equal(response.status, 200, `expected ${ip} to be allowed while budget lasts`);
      }

      // A visitor at 198.51.100.50 has used none of their own attempts…
      const request = new Request("http://localhost:3000/api/quota", { headers: TRUSTED });
      const quotaResponse = (await quotaEndpoint(request)) as Response;
      assert.equal(quotaResponse.status, 200);
      const body = await quotaResponse.json();
      assert.equal(body.quota.used, 0);
      assert.equal(body.quota.network_remaining, 3);
      // …but the shared ceiling makes previews unavailable anyway.
      assert.equal(body.quota.global_remaining, 0);
      assert.equal(body.quota.remaining, 0);
      assert.equal(body.quota.available, false);
      assert.equal(body.quota.variant, "global");

      const blocked = await post(await validForm(), { "x-vercel-forwarded-for": "198.51.100.63" });
      const blockedBody = await blocked.json();
      assert.equal(blocked.status, 429);
      assert.equal(blockedBody.details.variant, "global");
      assert.equal(blockedBody.details.quota.used, 0);
      assert.equal(blockedBody.details.counted, false);
      assert.doesNotMatch(
        String(blockedBody.message),
        /you.?ve used all of today.?s previews/i,
        "the global message must not blame the visitor's personal allowance",
      );
      assert.equal(h.provider.calls, 2);
    } finally {
      await h.close();
    }
  });
});

describe("GET /api/health", () => {
  test("reports booleans and never leaks configuration values", async () => {
    const h = await harness({ env: { DASHSCOPE_API_KEY: "sk-super-secret-value" } });
    try {
      const response = (await health(new Request("http://localhost:3000/api/health"))) as Response;
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.quotaConfigured, true);
      assert.equal(body.secretConfigured, true);
      assert.ok(!text.includes("sk-super-secret-value"));
      assert.ok(!text.includes(SECRET));
    } finally {
      await h.close();
    }
  });
});

describe("local development mode", () => {
  test("only works when explicitly enabled off-platform", async () => {
    const h = await harness();
    try {
      await withEnv({ VERCEL: undefined, ALLOW_LOCAL_QUOTA_MODE: "true" }, async () => {
        const response = (await generate(
          generateForm(await validForm(), { "x-vercel-forwarded-for": "" }),
        )) as Response;
        assert.equal(response.status, 200);
      });
    } finally {
      await h.close();
    }
  });

  test("cannot be used to bypass the platform identity check", async () => {
    const h = await harness({ env: { ALLOW_LOCAL_QUOTA_MODE: "true" } });
    try {
      const response = (await generate(
        generateForm(await validForm(), { "x-vercel-forwarded-for": "" }),
      )) as Response;
      assert.equal(response.status, 503, "VERCEL=1 plus local mode must still fail closed");
    } finally {
      await h.close();
    }
  });
});
