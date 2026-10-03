import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { route as feedback } from "../api/feedback.js";
import { setDbForTests } from "../lib/db.js";
import { createTestDb, type TestDb } from "./helpers.js";

const GENERATION_ID = "123e4567-e89b-12d3-a456-426614174000";

function post(body: unknown, origin = "http://localhost:5173"): Request {
  return new Request("http://localhost:3000/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function seedGeneration(db: TestDb): Promise<void> {
  await db.pglite.query(
    `insert into generations (id, npc_id, status, counted) values ($1, 'rose', 'success', true)`,
    [GENERATION_ID],
  );
}

describe("POST /api/feedback", () => {
  let db: TestDb;

  before(async () => {
    db = await createTestDb();
    setDbForTests(db.sql);
    await seedGeneration(db);
  });

  after(async () => {
    setDbForTests(null);
    await db.close();
  });

  test("stores a rating and strips control characters from the note", async () => {
    const response = (await feedback(
      post({
        generation_id: GENERATION_ID,
        rating: "kind_of",
        feedback_text: "  the sleeves\u0007 were too long\n\nand the bow missing  ",
        utm_source: "reddit",
      }),
    )) as Response;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const rows = await db.pglite.query("select rating, feedback_text, source from feedback");
    assert.deepEqual(rows.rows, [
      {
        rating: "kind_of",
        feedback_text: "the sleeves were too long and the bow missing",
        source: "reddit",
      },
    ]);
  });

  test("upserts when the visitor changes their mind", async () => {
    const response = (await feedback(
      post({ generation_id: GENERATION_ID, rating: "no", feedback_text: "colour was wrong" }),
    )) as Response;
    assert.equal(response.status, 200);

    const rows = await db.pglite.query("select count(*)::int as n, min(rating) as rating from feedback");
    assert.equal((rows.rows[0] as { n: number }).n, 1, "one row per generation");
    assert.equal((rows.rows[0] as { rating: string }).rating, "no");
  });

  test("rejects a malformed rating or generation id", async () => {
    const badRating = (await feedback(post({ generation_id: GENERATION_ID, rating: "meh" }))) as Response;
    assert.equal(badRating.status, 400);
    assert.equal((await badRating.json()).error, "bad_request");

    const badId = (await feedback(post({ generation_id: "not-a-uuid", rating: "yes" }))) as Response;
    assert.equal(badId.status, 400);
  });

  test("reports an unknown generation instead of silently accepting it", async () => {
    const response = (await feedback(
      post({ generation_id: "123e4567-e89b-12d3-a456-426614174999", rating: "yes" }),
    )) as Response;
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  });

  test("refuses a foreign origin", async () => {
    const response = (await feedback(post({ generation_id: GENERATION_ID, rating: "yes" }, "https://evil.example"))) as Response;
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden_origin");
  });
});
