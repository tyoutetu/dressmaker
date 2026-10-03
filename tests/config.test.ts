import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isUnlimitedNetwork,
  readNonNegativeDecimal,
  readQuotaLimits,
  USER_DAILY_GENERATION_LIMIT_MAX,
} from "../lib/config.js";
import { ApiError } from "../lib/errors.js";
import { estimatedCost } from "../lib/provider.js";

describe("per-network limit configuration", () => {
  test("defaults to the product maximum and allows lowering or zero", () => {
    assert.equal(USER_DAILY_GENERATION_LIMIT_MAX, 3);
    assert.deepEqual(readQuotaLimits({}), { userLimit: 3, globalLimit: 100 });
    assert.equal(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "2" }).userLimit, 2);
    assert.equal(readQuotaLimits({ USER_DAILY_GENERATION_LIMIT: "0" }).userLimit, 0);
  });

  test("fails closed when an operator tries to raise the ceiling for everyone", () => {
    for (const value of ["4", "10", "1000"]) {
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

describe("unlimited networks", () => {
  const env = { QUOTA_UNLIMITED_IPS: "203.0.113.7, 198.51.100.9" };

  test("matches exact addresses only, and ignores surrounding whitespace", () => {
    assert.equal(isUnlimitedNetwork("203.0.113.7", env), true);
    assert.equal(isUnlimitedNetwork("198.51.100.9", env), true);
    // A neighbouring address in the same subnet must NOT be exempt: that is how
    // a shared VPN exit would hand the exemption to strangers.
    assert.equal(isUnlimitedNetwork("203.0.113.8", env), false);
    assert.equal(isUnlimitedNetwork("203.0.113.0", env), false);
    assert.equal(isUnlimitedNetwork("", env), false);
  });

  test("nobody is exempt when the list is empty or missing", () => {
    assert.equal(isUnlimitedNetwork("203.0.113.7", {}), false);
    assert.equal(isUnlimitedNetwork("203.0.113.7", { QUOTA_UNLIMITED_IPS: "" }), false);
    assert.equal(isUnlimitedNetwork("203.0.113.7", { QUOTA_UNLIMITED_IPS: "  ,  " }), false);
  });

  test("raises only the per-network figure, never the global budget", () => {
    const plain = readQuotaLimits({ GLOBAL_DAILY_GENERATION_LIMIT: "100" });
    const exempt = readQuotaLimits({ GLOBAL_DAILY_GENERATION_LIMIT: "100" }, { unlimitedNetwork: true });
    assert.deepEqual(plain, { userLimit: 3, globalLimit: 100 });
    assert.deepEqual(exempt, { userLimit: 100, globalLimit: 100 });
    // The whole point: the exemption cannot raise the day's worst-case spend.
    assert.equal(exempt.globalLimit, plain.globalLimit);
  });

  test("the kill switch still wins for an exempt network", () => {
    assert.deepEqual(
      readQuotaLimits({ GLOBAL_DAILY_GENERATION_LIMIT: "0" }, { unlimitedNetwork: true }),
      { userLimit: 0, globalLimit: 0 },
    );
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
