import { config } from "../config.js";
import { fetchJson } from "../http.js";
import type { PerpsQuote } from "../types.js";

interface MetaAndAssetCtxs {
  0: {
    universe: Array<{ name: string; maxLeverage?: number }>;
  };
  1: Array<{
    markPx?: string;
    midPx?: string;
    oraclePx?: string;
    funding?: string;
    openInterest?: string;
  }>;
}

export async function getPerps(symbol: string): Promise<PerpsQuote> {
  const coin = symbol.trim().toUpperCase();
  const url = `${config.hyperliquid.baseUrl}/info`;
  const payload = await fetchJson<MetaAndAssetCtxs>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });

  // Response is a 2-tuple JSON array: [meta, assetCtxs]
  const meta = (payload as unknown as [MetaAndAssetCtxs[0], MetaAndAssetCtxs[1]])[0];
  const ctxs = (payload as unknown as [MetaAndAssetCtxs[0], MetaAndAssetCtxs[1]])[1];
  const idx = meta.universe.findIndex((u) => u.name.toUpperCase() === coin);
  if (idx < 0) {
    throw new Error(`Hyperliquid: unknown perp ${coin}`);
  }
  const u = meta.universe[idx];
  const ctx = ctxs[idx];
  return {
    provider: "hyperliquid",
    symbol: u.name,
    markPrice: ctx.markPx ? Number(ctx.markPx) : undefined,
    indexPrice: ctx.oraclePx ? Number(ctx.oraclePx) : undefined,
    fundingRate: ctx.funding ? Number(ctx.funding) : undefined,
    openInterest: ctx.openInterest ? Number(ctx.openInterest) : undefined,
    maxLeverage: u.maxLeverage,
    asOf: new Date().toISOString(),
  };
}
