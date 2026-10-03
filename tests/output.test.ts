import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { ApiError } from "../lib/errors";
import { normalizeOutputImage } from "../lib/output";

async function solid(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
}

describe("normalizeOutputImage dimension bound", () => {
  test("bounds the long edge of a portrait result", async () => {
    const out = await normalizeOutputImage(await solid(600, 3000), { maxDimension: 256 });
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, "png");
    assert.ok((meta.width ?? 0) <= 256, `width ${meta.width} must respect the bound`);
    assert.ok((meta.height ?? 0) <= 256, `height ${meta.height} must respect the bound`);
    assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 256);
  });

  test("bounds the long edge of a landscape result", async () => {
    const out = await normalizeOutputImage(await solid(3000, 600), { maxDimension: 256 });
    const meta = await sharp(out).metadata();
    assert.ok((meta.width ?? 0) <= 256);
    assert.ok((meta.height ?? 0) <= 256);
    assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 256);
  });

  test("never upscales an image that is already small", async () => {
    const out = await normalizeOutputImage(await solid(40, 30), { maxDimension: 256 });
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 40);
    assert.equal(meta.height, 30);
  });

  test("still rejects bytes that are not an image", async () => {
    await assert.rejects(
      normalizeOutputImage(Buffer.from("not an image")),
      (err: unknown) => err instanceof ApiError && err.code === "provider_error",
    );
  });
});
