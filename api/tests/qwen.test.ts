import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import sharp from "sharp";
import { ApiError } from "../lib/errors";
import {
  assertResultUrl,
  buildQwenImageBody,
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MODEL,
  parseQwenResponse,
  resolveImageEndpoint,
  QwenProvider,
} from "../lib/providers/qwen";
import { tinyJpeg, tinyPng } from "./helpers";

describe("Qwen request contract", () => {
  test("sends both images as data URLs with n=1 and a fixed size", async () => {
    const reference = { data: await tinyPng("#abcdef"), mime: "image/png" };
    const dress = { data: await tinyJpeg("#123456"), mime: "image/jpeg" };

    const body = buildQwenImageBody({
      model: "qwen-image-3.0",
      prompt: "keep the customer, change the dress",
      npcReference: reference,
      dressScreenshot: dress,
    });

    assert.equal(body.model, "qwen-image-3.0");
    assert.equal(body.n, 1);
    assert.equal(body.size, "1024x1024");
    // The platform defaults both to true; this product must override them
    // explicitly, because omitting a field would re-enable prompt rewriting
    // and slow thinking mode.
    assert.equal(body.prompt_extend, false, "prompt rewriting must be off by default");
    assert.equal(body.enable_thinking, false, "thinking mode must be off by default");

    const images = body.image as string[];
    assert.equal(images.length, 2);
    assert.ok(images[0].startsWith("data:image/png;base64,"), "reference must come first as PNG");
    assert.ok(images[1].startsWith("data:image/jpeg;base64,"), "dress must come second as JPEG");
    assert.equal(images[0].split(",")[1], reference.data.toString("base64"));
    assert.equal(images[1].split(",")[1], dress.data.toString("base64"));
  });

  test("honours an explicit prompt_extend setting", () => {
    const body = buildQwenImageBody({
      model: "m",
      prompt: "p",
      npcReference: { data: Buffer.from([1]), mime: "image/png" },
      dressScreenshot: { data: Buffer.from([2]), mime: "image/jpeg" },
      promptExtend: true,
    });
    assert.equal(body.prompt_extend, true);
  });

  test("honours an explicit enable_thinking setting", () => {
    const body = buildQwenImageBody({
      model: "m",
      prompt: "p",
      npcReference: { data: Buffer.from([1]), mime: "image/png" },
      dressScreenshot: { data: Buffer.from([2]), mime: "image/jpeg" },
      promptExtend: true,
      enableThinking: true,
    });
    assert.equal(body.enable_thinking, true);
  });

  test("refuses thinking mode without prompt extend, before any paid call", () => {
    assert.throws(
      () =>
        new QwenProvider({
          baseUrl: "http://127.0.0.1:9",
          allowTestEndpoints: true,
          promptExtend: false,
          enableThinking: true,
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.code === "service_unavailable" &&
        /QWEN_ENABLE_THINKING/.test(err.message),
      "thinking without prompt extend would be silently ignored by the platform, so it must fail closed here",
    );
  });

  test("builds the documented OpenAI-compatible endpoint", () => {
    assert.equal(
      resolveImageEndpoint("https://dashscope.aliyuncs.com").toString(),
      "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
    );
    assert.equal(
      resolveImageEndpoint("https://ws-123.cn-beijing.maas.aliyuncs.com/").toString(),
      "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations",
    );
    assert.equal(
      resolveImageEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1").toString(),
      "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
    );
    // 千问AI平台 / QwenCloud, the default platform.
    assert.equal(
      resolveImageEndpoint("https://maas.qianwenaiapi.com").toString(),
      "https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations",
    );
    assert.equal(
      resolveImageEndpoint("https://maas.qianwenaiapi.com/compatible-mode/v1").toString(),
      "https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations",
    );
  });

  test("the default platform is the documented QwenCloud host", () => {
    assert.equal(DEFAULT_QWEN_BASE_URL, "https://maas.qianwenaiapi.com");
    assert.equal(new QwenProvider({ apiKey: "k" }).model, DEFAULT_QWEN_MODEL);
  });

  test("rejects unsafe or unexpected endpoints", () => {
    for (const bad of [
      "http://dashscope.aliyuncs.com",
      "https://evil.example.com",
      "https://dashscope.aliyuncs.com.evil.example",
      "https://user:pass@dashscope.aliyuncs.com",
      "https://127.0.0.1",
      "not a url",
      // Adding a second allowed platform must not open a suffix-spoofing hole.
      "https://qianwenaiapi.com.evil.example",
      "https://evil-qianwenaiapi.com",
      "http://maas.qianwenaiapi.com",
    ]) {
      assert.throws(
        () => resolveImageEndpoint(bad),
        (err: unknown) => err instanceof ApiError && err.code === "service_unavailable",
        `expected ${bad} to be rejected`,
      );
    }
  });

  test("rejects result URLs that are not Aliyun-hosted https", () => {
    assert.equal(
      assertResultUrl("https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/a.png").hostname,
      "dashscope-result-sh.oss-cn-shanghai.aliyuncs.com",
    );
    for (const bad of ["http://dashscope.aliyuncs.com/a.png", "https://evil.example.com/a.png", "https://127.0.0.1/a.png"]) {
      assert.throws(
        () => assertResultUrl(bad),
        (err: unknown) => err instanceof ApiError && err.code === "provider_error",
        `expected ${bad} to be rejected`,
      );
    }
  });

  test("parses success and moderation responses", () => {
    assert.deepEqual(parseQwenResponse(JSON.stringify({ data: [{ url: "https://x.aliyuncs.com/a.png" }] })), {
      ok: true,
      url: "https://x.aliyuncs.com/a.png",
      b64: undefined,
    });
    assert.deepEqual(parseQwenResponse(JSON.stringify({ data: [{ b64_json: "AAA" }] })), {
      ok: true,
      url: undefined,
      b64: "AAA",
    });
    assert.equal(parseQwenResponse(JSON.stringify({ data: [] })).ok, false);
    assert.equal(parseQwenResponse("not json").ok, false);

    const refusal = parseQwenResponse(
      JSON.stringify({ code: "DataInspectionFailed", message: "sensitive content detected" }),
    );
    assert.equal(refusal.ok, false);
    assert.equal(refusal.safety, true);
  });

  test("handles JSON null, arrays and primitives without throwing", () => {
    for (const payload of ["null", "[]", "42", '"a string"', "true", "{}", '{"data": null}', '{"data": "nope"}']) {
      const parsed = parseQwenResponse(payload);
      assert.equal(parsed.ok, false, `${payload} must be a clean failure`);
      if (!parsed.ok) assert.equal(parsed.safety, false);
    }
    assert.equal(parseQwenResponse("[{\"url\":\"https://x.aliyuncs.com/a.png\"}]").ok, false);
  });
});

const BASE_URL = "http://127.0.0.1:9";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** Deterministic fetch stand-in: no sockets, no network, fully inspectable. */
function makeFetch(
  handler: (call: RecordedCall) => Promise<Response> | Response,
  log: RecordedCall[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: typeof input === "string" ? input : input.toString(), init };
    log.push(call);
    return handler(call);
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Buffer -> BodyInit without tripping the ArrayBuffer-backed view typing. */
function binaryResponse(buffer: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(Uint8Array.from(buffer), { headers: { "content-type": "image/png", ...headers } });
}

function makeProvider(fetchImpl: typeof fetch): QwenProvider {
  return new QwenProvider({
    baseUrl: BASE_URL,
    model: "qwen-image-3.0",
    apiKey: "test-key",
    allowTestEndpoints: true,
    fetchImpl,
  });
}

function sampleInput(dressJpeg: Buffer) {
  return {
    npcReference: { data: Buffer.from([1, 2, 3]), mime: "image/png" },
    dressScreenshot: { data: dressJpeg, mime: "image/jpeg" },
    prompt: "prompt",
    signal: AbortSignal.timeout(5_000),
  };
}

describe("QwenProvider request lifecycle", () => {
  let png: Buffer;
  let jpeg: Buffer;
  const resultUrl = "https://dashscope-result.oss-cn-beijing.aliyuncs.com/out/result.png";

  before(async () => {
    png = await tinyPng("#334455");
    jpeg = await tinyJpeg("#aabbcc");
  });

  test("posts the documented JSON body and returns a PNG", async () => {
    const log: RecordedCall[] = [];
    const provider = makeProvider(
      makeFetch((call) => {
        if (call.url.includes("/compatible-mode/v1/images/generations")) {
          return jsonResponse({ data: [{ url: resultUrl }] }, { headers: { "x-request-id": "req-1" } });
        }
        return binaryResponse(png);
      }, log),
    );
    const result = await provider.generate(sampleInput(jpeg));

    assert.equal(result.providerRequestId, "req-1");
    assert.ok(result.image.length > 0);
    const meta = await sharp(result.image).metadata();
    assert.equal(meta.format, "png");

    assert.equal(log.length, 2, "one POST then one image download");
    const [post, download] = log;
    assert.equal(post.url, "http://127.0.0.1:9/compatible-mode/v1/images/generations");
    assert.equal(post.init?.method, "POST");
    assert.equal(new Headers(post.init?.headers).get("authorization"), "Bearer test-key");
    const body = JSON.parse(String(post.init?.body)) as Record<string, unknown>;
    assert.equal(body.n, 1);
    assert.equal(body.model, "qwen-image-3.0");
    assert.equal(body.size, "1024x1024");
    assert.equal((body.image as string[]).length, 2);

    assert.equal(download.url, resultUrl);
    assert.equal(download.init?.redirect, "manual");
    assert.equal(new Headers(download.init?.headers ?? {}).get("authorization"), null);
  });

  test("follows one redirect to another allowed host", async () => {
    const provider = makeProvider(
      makeFetch((call) => {
        if (call.url.includes("/compatible-mode")) {
          return jsonResponse({ data: [{ url: resultUrl }] });
        }
        if (call.url === resultUrl) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://dashscope-result.oss-cn-shanghai.aliyuncs.com/final.png" },
          });
        }
        return binaryResponse(png);
      }),
    );
    const result = await provider.generate(sampleInput(jpeg));
    assert.ok(result.image.length > 0);
  });

  test("refuses a redirect to a non-Aliyun host", async () => {
    const provider = makeProvider(
      makeFetch((call) => {
        if (call.url.includes("/compatible-mode")) {
          return jsonResponse({ data: [{ url: resultUrl }] });
        }
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.png" } });
      }),
    );
    await assert.rejects(
      provider.generate(sampleInput(jpeg)),
      (err: unknown) => err instanceof ApiError && err.code === "provider_error",
    );
  });

  test("maps rate limiting to a rate_limit error", async () => {
    const provider = makeProvider(
      makeFetch(() => jsonResponse({ code: "Throttling", message: "slow down" }, { status: 429 })),
    );
    await assert.rejects(
      provider.generate(sampleInput(jpeg)),
      (err: unknown) => err instanceof ApiError && err.code === "rate_limit",
    );
  });

  test("maps content moderation to a safety rejection", async () => {
    const provider = makeProvider(
      makeFetch(() =>
        jsonResponse({ code: "DataInspectionFailed", message: "sensitive content" }, { status: 400 }),
      ),
    );
    await assert.rejects(
      provider.generate(sampleInput(jpeg)),
      (err: unknown) => err instanceof ApiError && err.code === "safety_rejection",
    );
  });

  test("maps credential failures to a service error without leaking the key", async () => {
    const provider = makeProvider(
      makeFetch(() => jsonResponse({ code: "InvalidApiKey", message: "bad key" }, { status: 401 })),
    );
    await assert.rejects(provider.generate(sampleInput(jpeg)), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "service_unavailable");
      assert.ok(!err.message.includes("test-key"));
      return true;
    });
  });

  test("aborts a hung request and reports a timeout", async () => {
    const provider = makeProvider(
      makeFetch(
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init?.signal?.addEventListener("abort", () => reject(call.init?.signal?.reason));
          }),
      ),
    );
    await assert.rejects(
      provider.generate({ ...sampleInput(jpeg), signal: AbortSignal.timeout(60) }),
      (err: unknown) => err instanceof ApiError && err.code === "timeout",
    );
  });

  test("refuses an oversized download instead of buffering it", async () => {
    const provider = makeProvider(
      makeFetch((call) => {
        if (call.url.includes("/compatible-mode")) return jsonResponse({ data: [{ url: resultUrl }] });
        return new Response(new Blob([new Uint8Array(9_000_000)]), {
          headers: { "content-type": "image/png" },
        });
      }),
    );
    await assert.rejects(
      provider.generate(sampleInput(jpeg)),
      (err: unknown) => err instanceof ApiError && err.code === "provider_error",
    );
  });

  test("refuses a non-image result", async () => {
    const provider = makeProvider(
      makeFetch((call) => {
        if (call.url.includes("/compatible-mode")) return jsonResponse({ data: [{ url: resultUrl }] });
        return new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } });
      }),
    );
    await assert.rejects(
      provider.generate(sampleInput(jpeg)),
      (err: unknown) => err instanceof ApiError && err.code === "provider_error",
    );
  });
});
