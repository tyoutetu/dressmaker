import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  readNonNegativeDecimal,
  readQuotaLimits,
  USER_DAILY_GENERATION_LIMIT_MAX,
} from "../lib/config";
import { ApiError } from "../lib/errors";
import { estimatedCost } from "../lib/provider";

describe("per-network limit configuration", () => {
  test("defaults to the sanity ceiling and allows lowering or zero", () => {
    assert.equal(USER_DAILY_GENERATION_LIMIT_MAX, 100);
    assert.deepEqual(readQuotaLimits({}), { userLimit: 100, globalLimit: 100 });
    assert.equal(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "2" }).userLimit, 2);
    assert.equal(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "0" }).userLimit, 0);
  });

  test("accepts a per-network limit up to the ceiling, so it can stop binding", () => {
    assert.equal(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "100" }).userLimit, 100);
    // Raising this cannot raise the daily spend: the global ceiling is what
    // bounds cost, and it is read separately.
    assert.deepEqual(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "100" }), {
      userLimit: 100,
      globalLimit: 100,
    });
  });

  test("fails closed when an operator mistypes it above the ceiling", () => {
    for (const value of ["101", "1000", "99999"]) {
      assert.throws(
        () => readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: value }),
        (err: unknown) => err instanceof ApiError && err.code === "service_unavailable",
        `expected ${value} to be rejected`,
      );
    }
  });

  test("still fails closed on a malformed value", () => {
    assert.throws(() => readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "three" }));
  });
});

describe("operator cost estimates", () => {
  test("reads a decimal USD value exactly instead of truncating it to zero", () => {
    const env = { ESTIMATED_COST_QWEN_PER_IMAGE_USD: "0.03" };
    assert.equal(readNonNegativeDecimal(env, "ESTIMATED_COST_QWEN_PER_IMAGE_USD"), 0.03);
    assert.equal(readNonNegativeDecimal({ X: "12" }, "X"), 12);
    assert.equal(readNonNegativeDecimal({ X: "0" }, "X"), 0);
    assert.equal(readNonNegativeDecimal({ X: "0.5" }, "X"), 0.5);
    for (const bad of ["", "abc", "-1", "1e3", "0.0.0", "  "]) {
      assert.equal(readNonNegativeDecimal({ X: bad }, "X"), undefined, `expected ${bad} to be rejected`);
    }
  });

  test("omits the estimate entirely when the operator has not set one", () => {
    const key = "ESTIMATED_COST_FAKEPROVIDER_PER_IMAGE_USD";
    const previous = process.env[key];
    try {
      delete process.env[key];
      assert.equal(estimatedCost("fakeprovider"), undefined);
      process.env[key] = "0.03";
      assert.equal(estimatedCost("fakeprovider"), 0.03);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});
