import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  declaredBodyTooLarge,
  readBoundedFormData,
  readBoundedJson,
  requestBodyLimitBytes,
} from "../lib/body";
import { ApiError } from "../lib/errors";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("bounded request bodies", () => {
  test("a declared length over the ceiling is spotted before the body is read", () => {
    assert.equal(declaredBodyTooLarge(new Headers({ "content-length": "999999" }), 1024), true);
    assert.equal(declaredBodyTooLarge(new Headers({ "content-length": "512" }), 1024), false);
    assert.equal(declaredBodyTooLarge(new Headers(), 1024), false);
    assert.equal(declaredBodyTooLarge(new Headers({ "content-length": "not-a-number" }), 1024), false);
  });

  test("reads a small multipart form unchanged", async () => {
    const form = new FormData();
    form.append("npc_id", "rose");
    form.append("image", new File([new Uint8Array([1, 2, 3])], "d.jpg", { type: "image/jpeg" }));
    const request = new Request("http://localhost:3000/api/generate", { method: "POST", body: form });
    const parsed = await readBoundedFormData(request, requestBodyLimitBytes(4 * 1024 * 1024));
    assert.equal(parsed.get("npc_id"), "rose");
    assert.ok(parsed.get("image") instanceof File);
  });

  test("refuses an oversized multipart body while streaming", async () => {
    const form = new FormData();
    form.append("image", new File([new Uint8Array(200_000)], "big.jpg", { type: "image/jpeg" }));
    const request = new Request("http://localhost:3000/api/generate", { method: "POST", body: form });
    await assert.rejects(
      readBoundedFormData(request, 1024),
      (err: unknown) => err instanceof ApiError && err.status === 413 && err.code === "invalid_image",
    );
  });

  test("refuses an oversized JSON body", async () => {
    const request = jsonRequest({ feedback_text: "x".repeat(200_000) });
    await assert.rejects(
      readBoundedJson(request, 1024),
      (err: unknown) => err instanceof ApiError && err.status === 413 && err.code === "bad_request",
    );
  });

  test("reports malformed JSON as a bad request rather than throwing raw", async () => {
    const request = new Request("http://localhost:3000/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    await assert.rejects(
      readBoundedJson(request, 1024),
      (err: unknown) => err instanceof ApiError && err.code === "bad_request",
    );
  });
});
