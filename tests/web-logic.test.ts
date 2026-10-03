import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyFetchFailure,
  countedFromDetails,
  failureChargeNote,
  generationAllowed,
  quotaBlockCopy,
} from "../web/src/lib/outcome.js";
import { dataUrlToBlob, prepareResultDownload, resultFilename } from "../web/src/lib/download.js";

/**
 * The browser cannot know the outcome of a request it never finished reading,
 * so these pure helpers are where "counted / not counted / unknown" is decided
 * and where the visitor-facing copy comes from.
 */

describe("paid-attempt outcome honesty", () => {
  test("maps the server flag onto true / false / unknown", () => {
    assert.equal(countedFromDetails({ counted: true }), "true");
    assert.equal(countedFromDetails({ counted: false }), "false");
    assert.equal(countedFromDetails({}), "unknown");
    assert.equal(countedFromDetails(undefined), "unknown");
    assert.equal(countedFromDetails(null), "unknown");
    assert.equal(countedFromDetails({ counted: "yes" }), "unknown");
  });

  test("a timeout or lost connection is unknown, never free", () => {
    const timeout = classifyFetchFailure(Object.assign(new Error("slow"), { name: "TimeoutError" }));
    assert.equal(timeout.code, "timeout");
    assert.equal(timeout.counted, "unknown");
    assert.match(timeout.message, /may have been used/i);
    assert.doesNotMatch(timeout.message, /not charged|nothing else was charged|were not used/i);

    const abort = classifyFetchFailure(Object.assign(new Error("aborted"), { name: "AbortError" }));
    assert.equal(abort.counted, "unknown");

    const network = classifyFetchFailure(new TypeError("Failed to fetch"));
    assert.equal(network.code, "network");
    assert.equal(network.counted, "unknown");
    assert.match(network.message, /may have been used/i);
  });

  test("copy distinguishes counted, not counted and unknown", () => {
    assert.match(failureChargeNote("true"), /used one of today's previews/i);
    assert.match(failureChargeNote("false"), /None of today's previews were used/i);
    const unknown = failureChargeNote("unknown");
    assert.match(unknown, /could not confirm/i);
    assert.match(unknown, /may have used one of today's previews/i);
    assert.doesNotMatch(unknown, /^None of today's previews/);
  });
});

describe("generation availability gate", () => {
  const ready = {
    quotaState: "fresh",
    quota: { available: true },
    ready: true,
    busy: false,
  } as const;

  test("only allows generation with a fresh, available quota", () => {
    assert.equal(generationAllowed(ready), true);
  });

  test("fails closed while checking, stale or without a snapshot", () => {
    assert.equal(generationAllowed({ ...ready, quotaState: "checking" }), false);
    assert.equal(generationAllowed({ ...ready, quotaState: "stale" }), false);
    assert.equal(generationAllowed({ ...ready, quota: null }), false);
  });

  test("fails closed when the quota has no headroom or the form is incomplete", () => {
    assert.equal(generationAllowed({ ...ready, quota: { available: false } }), false);
    assert.equal(generationAllowed({ ...ready, ready: false }), false);
    assert.equal(generationAllowed({ ...ready, busy: true }), false);
  });
});

describe("quota-unavailable copy", () => {
  test("a spent global budget never claims the visitor used their own previews", () => {
    const copy = quotaBlockCopy("global");
    assert.match(copy.title, /budget is spent/i);
    assert.doesNotMatch(copy.title, /you have used/i);
    assert.match(copy.body, /not used up/i);
  });

  test("a personal limit and a disabled service read differently", () => {
    assert.match(quotaBlockCopy("network").title, /you have used today's previews/i);
    assert.match(quotaBlockCopy("disabled").title, /paused/i);
  });
});

/**
 * The result download is a real `<a download href="blob:...">`; the component
 * creates the object URL in an effect and releases it on result change or
 * unmount. These tests cover the pure decode and the create/release pairing the
 * effect relies on, including the Strict Mode double-invoke case.
 */

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

/** Replace `URL.createObjectURL`/`revokeObjectURL` with a counter and restore on exit. */
function withObjectUrlStub(
  run: (stub: {
    created: Blob[];
    revoked: string[];
    live: Set<string>;
  }) => void | Promise<void>,
): Promise<void> {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const live = new Set<string>();
  const originalURL = globalThis.URL;
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: (blob: Blob) => {
      const url = `blob:result-${created.length + 1}`;
      created.push(blob);
      live.add(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
      live.delete(url);
    },
  };
  return Promise.resolve(run({ created, revoked, live })).finally(() => {
    (globalThis as { URL: unknown }).URL = originalURL;
  });
}

describe("result download", () => {
  test("decodes a PNG data URL into a blob with the exact bytes", async () => {
    const blob = dataUrlToBlob(PNG_DATA_URL);
    assert.equal(blob.type, "image/png");
    assert.equal(blob.size, PNG_BYTES.length);
    const decoded = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...decoded], [...PNG_BYTES]);
    // The reviewer's check: the bytes handed to the browser open with the PNG signature.
    assert.deepEqual([...decoded.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("rejects a value that is not a data URL", () => {
    assert.throws(() => dataUrlToBlob("https://example.com/a.png"));
  });

  test("names the file after the customer and a UTC timestamp", () => {
    assert.equal(
      resultFilename("rose", new Date("2026-10-02T09:15:30.000Z")),
      "dressmaker-rose-2026-10-02-09-15-30.png",
    );
  });

  test("prepares one object URL for the result and releases it exactly once", async () => {
    await withObjectUrlStub((stub) => {
      const download = prepareResultDownload(PNG_DATA_URL, "dressmaker-rose.png");

      assert.equal(stub.created.length, 1);
      assert.equal(stub.created[0].type, "image/png");
      assert.equal(stub.created[0].size, PNG_BYTES.length);
      assert.equal(download.url, "blob:result-1");
      assert.equal(download.filename, "dressmaker-rose.png");
      assert.deepEqual(stub.revoked, [], "the URL stays live while the result is on screen");

      download.dispose();
      download.dispose(); // a second release must not double-revoke
      assert.deepEqual(stub.revoked, ["blob:result-1"]);
      assert.equal(stub.live.size, 0);
    });
  });

  test("a failed decode never creates an object URL", async () => {
    await withObjectUrlStub((stub) => {
      assert.throws(() => prepareResultDownload("not-a-data-url", "rose.png"));
      assert.deepEqual(stub.created, []);
      assert.deepEqual(stub.revoked, []);
    });
  });

  test("Strict Mode's mount, cleanup, mount cycle leaves exactly one live URL", async () => {
    await withObjectUrlStub((stub) => {
      const first = prepareResultDownload(PNG_DATA_URL, "rose.png");
      first.dispose(); // Strict Mode's immediate cleanup of the first mount
      const second = prepareResultDownload(PNG_DATA_URL, "rose.png");

      assert.notEqual(first.url, second.url, "each effect run owns a fresh URL");
      assert.deepEqual([...stub.live], [second.url], "only the live mount's URL survives");
      assert.deepEqual(stub.revoked, [first.url]);

      second.dispose(); // unmount
      assert.equal(stub.live.size, 0);
    });
  });
});
