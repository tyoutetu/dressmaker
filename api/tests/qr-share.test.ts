import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alignmentPositions, chooseVersion, encodeQr, MAX_QR_VERSION } from "../../web/src/lib/qr";
import {
  canShareImage,
  displayUrl,
  normalizeSiteUrl,
  qrGeometry,
  shareDisclaimer,
  shareFilename,
  shareHeadline,
  shareLayout,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
} from "../../web/src/lib/shareCard";

/**
 * The share card is the one artefact that leaves the site, so it has to be right
 * without anyone looking at it: a QR that does not decode, or a link that points
 * nowhere, is worse than no share button at all. These tests cover the parts that
 * can be checked without a canvas — the encoder's structure and the URL/copy
 * rules — while the rendered pixels are verified against an independent decoder.
 */

function finderPatternAt(matrix: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      const expected = ring !== 2; // outer ring dark, inner ring light, core dark
      if (matrix[y0 + dy][x0 + dx] !== expected) return false;
    }
  }
  return true;
}

describe("QR encoder", () => {
  test("picks the smallest version that fits, and grows with the payload", () => {
    assert.equal(chooseVersion(10), 1);
    // Version 1 at level M holds 16 data codewords = 4 + 8 + payload bits.
    assert.equal(chooseVersion(14), 1);
    assert.equal(chooseVersion(15), 2);
    assert.ok(chooseVersion(200) > chooseVersion(100));
  });

  test("refuses payloads that cannot fit instead of truncating", () => {
    assert.throws(() => encodeQr(""), /Nothing to encode/);
    assert.throws(() => encodeQr("x".repeat(400)), /too long/);
  });

  test("emits a square matrix sized by its version", () => {
    for (const text of ["https://a.co/", "https://example.com/some/path", "x".repeat(120)]) {
      const qr = encodeQr(text);
      assert.equal(qr.matrix.length, qr.size);
      assert.equal(qr.size, qr.version * 4 + 17);
      for (const row of qr.matrix) assert.equal(row.length, qr.size);
      assert.ok(qr.version >= 1 && qr.version <= MAX_QR_VERSION);
    }
  });

  test("draws all three finder patterns", () => {
    const qr = encodeQr("https://example.com/");
    const last = qr.size - 7;
    assert.ok(finderPatternAt(qr.matrix, 0, 0), "top-left finder");
    assert.ok(finderPatternAt(qr.matrix, last, 0), "top-right finder");
    assert.ok(finderPatternAt(qr.matrix, 0, last), "bottom-left finder");
  });

  test("is deterministic, so a shared link always encodes identically", () => {
    const a = encodeQr("https://example.com/");
    const b = encodeQr("https://example.com/");
    assert.deepEqual(a.matrix, b.matrix);
    assert.equal(a.version, b.version);
  });

  test("a different URL produces a different matrix", () => {
    const a = encodeQr("https://example.com/");
    const b = encodeQr("https://example.org/");
    assert.notDeepEqual(a.matrix, b.matrix);
  });

  test("places alignment patterns from version 2 onward, and never on a finder", () => {
    assert.deepEqual(alignmentPositions(1), []);
    assert.deepEqual(alignmentPositions(2), [6, 18]);
    assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
    assert.deepEqual(alignmentPositions(10), [6, 28, 50]);
  });
});

describe("share card URL rules", () => {
  test("accepts an ordinary site address", () => {
    assert.equal(normalizeSiteUrl("https://example.com/"), "https://example.com/");
  });

  test("keeps a sub-path, because GitHub Pages project sites live under /<repo>/", () => {
    assert.equal(
      normalizeSiteUrl("https://user.github.io/dressmaker/"),
      "https://user.github.io/dressmaker/",
    );
  });

  test("drops query and hash so the code points at the tool, not someone's campaign", () => {
    assert.equal(
      normalizeSiteUrl("https://example.com/tool?utm_source=share#result"),
      "https://example.com/tool",
    );
  });

  test("trims surrounding whitespace", () => {
    assert.equal(normalizeSiteUrl("  https://example.com/  "), "https://example.com/");
  });

  test("returns null when there is nothing usable to encode", () => {
    for (const bad of [undefined, null, "", "   ", "not a url", "/relative/path", "mailto:a@b.c", "javascript:alert(1)"]) {
      assert.equal(normalizeSiteUrl(bad), null, `${String(bad)} must not be shareable`);
    }
  });

  test("prints the address without its scheme or trailing slash", () => {
    assert.equal(displayUrl("https://example.com/"), "example.com");
    assert.equal(displayUrl("https://user.github.io/dressmaker/"), "user.github.io/dressmaker");
  });

  test("names the file after the customer and a UTC timestamp", () => {
    const at = new Date("2026-10-02T13:45:07Z");
    assert.equal(shareFilename("rose", at), "dressmaker-rose-share-2026-10-02-13-45-07.png");
  });
});

describe("share capability", () => {
  test("requires both share and canShare before offering the share sheet", () => {
    assert.equal(canShareImage(undefined, { type: "image/png" }), false);
    assert.equal(canShareImage({}, { type: "image/png" }), false);
    assert.equal(canShareImage({ share: async () => {} }, { type: "image/png" }), false);
    assert.equal(canShareImage({ canShare: () => true }, { type: "image/png" }), false);
  });

  test("uses the browser's answer when it can give one", () => {
    const file = { type: "image/png" };
    assert.equal(canShareImage({ share: async () => {}, canShare: () => true }, file), true);
    assert.equal(canShareImage({ share: async () => {}, canShare: () => false }, file), false);
  });

  test("treats a throwing canShare as unsupported rather than crashing the result page", () => {
    const nav = {
      share: async () => {},
      canShare: () => {
        throw new TypeError("no files here");
      },
    };
    assert.equal(canShareImage(nav, { type: "image/png" }), false);
  });
});

describe("share card layout", () => {
  test("keeps every element inside the canvas", () => {
    const l = shareLayout();
    assert.equal(l.width, SHARE_CARD_WIDTH);
    assert.equal(l.height, SHARE_CARD_HEIGHT);
    assert.ok(l.photo.x >= 0 && l.photo.y >= 0);
    assert.ok(l.photo.x + l.photo.size <= l.width, "photo fits horizontally");
    assert.ok(l.photo.y + l.photo.size <= l.text.footerTop, "photo leaves room for the footer");
    assert.ok(l.qr.x + l.qr.block <= l.width, "QR block fits horizontally");
    assert.ok(l.qr.y + l.qr.block <= l.height, "QR block fits vertically");
    assert.ok(l.qr.y >= l.text.footerTop, "QR block sits inside the footer band");
  });

  test("gives the QR its required four-module light margin at every version", () => {
    const l = shareLayout();
    // Version 1 has 21 modules; version 10 has 57. A fixed pixel margin cannot
    // satisfy both, which is exactly the bug this asserts against.
    for (const modules of [21, 29, 37, 57]) {
      const g = qrGeometry(modules, l.qr.block);
      assert.ok(g.size + g.quietZone * 2 <= l.qr.block + 1e-9, `v${modules} fits its block`);
      assert.ok(
        g.quietZone >= 4 * g.moduleSize - 1e-9,
        `v${modules} quiet zone is at least four modules`,
      );
    }
  });

  test("rejects a nonsense module count instead of dividing by zero", () => {
    assert.throws(() => qrGeometry(0, 264), /positive/);
    assert.throws(() => qrGeometry(Number.NaN, 264), /positive/);
  });

  test("keeps the text column clear of the QR code", () => {
    const l = shareLayout();
    assert.ok(
      l.text.x + l.text.maxWidth <= l.qr.x,
      "text must never run under the QR code",
    );
  });
});

describe("share card copy", () => {
  test("names the customer and never claims the preview is an in-game result", () => {
    assert.match(shareHeadline("Rose"), /Rose/);
    assert.match(shareDisclaimer(), /not an in-game result/i);
    assert.match(shareDisclaimer(), /unofficial/i);
  });
});
