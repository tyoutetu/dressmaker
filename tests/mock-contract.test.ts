import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMockApi } from "../scripts/mock-server";
import { tinyJpeg } from "./helpers";

/**
 * The local mock exists so a reviewer can click through the whole flow. It has
 * to behave like the real API — same routes, same quota contract, same error
 * shapes — and it has to be impossible to mistake its output for AI art.
 */

async function generateForm(npcId = "rose"): Promise<FormData> {
  const form = new FormData();
  form.append("npc_id", npcId);
  form.append("client_id", "reviewer");
  form.append("image", new File([new Uint8Array(await tinyJpeg())], "dress.jpg", { type: "image/jpeg" }));
  return form;
}

describe("local mock API contract", () => {
  test("exposes the health and quota routes the frontend expects", async () => {
    const api = createMockApi({ userLimit: 3, globalLimit: 100 });

    const health = await api.fetch({ method: "GET", pathname: "/api/health" });
    assert.equal(health.status, 200);
    assert.equal(health.body.provider, "mock");
    assert.equal(health.body.mock, true);

    const quota = await api.fetch({ method: "GET", pathname: "/api/quota" });
    assert.equal(quota.status, 200);
    const snapshot = quota.body.quota as { remaining: number; limit: number; scope: string; reset_at: string };
    assert.equal(snapshot.limit, 3);
    assert.equal(snapshot.remaining, 3);
    assert.equal(snapshot.scope, "network");
    assert.equal(quota.body.mock, true);
  });

  test("returns three previews per UTC day, then blocks, without calling a model", async () => {
    const api = createMockApi({ userLimit: 3, globalLimit: 100 });

    for (let i = 1; i <= 3; i++) {
      const result = await api.fetch({ method: "POST", pathname: "/api/generate", form: await generateForm() });
      assert.equal(result.status, 200);
      assert.equal(result.body.mock, true);
      assert.equal((result.body.quota as { remaining: number }).remaining, 3 - i);
      assert.match(String(result.body.image), /^data:image\/png;base64,/);
    }

    const blocked = await api.fetch({ method: "POST", pathname: "/api/generate", form: await generateForm("priya") });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "limit_reached");
    const details = blocked.body.details as { variant: string; counted: boolean; quota: { remaining: number; reset_at: string } };
    assert.equal(details.variant, "network");
    assert.equal(details.counted, false);
    assert.equal(details.quota.remaining, 0);
    assert.ok(Date.parse(details.quota.reset_at) > Date.now());
  });

  test("rejects unknown customers and missing screenshots like the real API", async () => {
    const api = createMockApi();
    const unknown = await api.fetch({ method: "POST", pathname: "/api/generate", form: await generateForm("dorothy") });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "bad_request");

    const empty = new FormData();
    empty.append("npc_id", "rose");
    const missing = await api.fetch({ method: "POST", pathname: "/api/generate", form: empty });
    assert.equal(missing.status, 400);
  });

  test("counts an intentionally failed generation so the UI can show real copy", async () => {
    const api = createMockApi({ userLimit: 3, failure: "timeout" });
    const failed = await api.fetch({ method: "POST", pathname: "/api/generate", form: await generateForm() });
    assert.equal(failed.status, 504);
    assert.equal(failed.body.error, "timeout");
    const details = failed.body.details as { counted: boolean; quota: { used: number; remaining: number } };
    assert.equal(details.counted, true);
    assert.equal(details.quota.used, 1);
    assert.equal(details.quota.remaining, 2);
  });

  test("accepts the same feedback payload the real endpoint does", async () => {
    const api = createMockApi();
    const ok = await api.fetch({
      method: "POST",
      pathname: "/api/feedback",
      json: { generation_id: "123e4567-e89b-12d3-a456-426614174000", rating: "kind_of", feedback_text: "shorter sleeves" },
    });
    assert.equal(ok.status, 200);

    const bad = await api.fetch({ method: "POST", pathname: "/api/feedback", json: { rating: "meh" } });
    assert.equal(bad.status, 400);
  });
});
