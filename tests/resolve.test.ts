import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCoinGeckoId } from "../src/index.ts";

describe("resolveCoinGeckoId", () => {
  it("maps common symbols", () => {
    assert.equal(resolveCoinGeckoId("btc"), "bitcoin");
    assert.equal(resolveCoinGeckoId("SOL"), "solana");
  });

  it("passes through explicit ids", () => {
    assert.equal(resolveCoinGeckoId("bitcoin"), "bitcoin");
  });
});
