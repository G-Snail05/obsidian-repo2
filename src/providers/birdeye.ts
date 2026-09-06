import { config } from "../config.js";
import { fetchJson } from "../http.js";
import type { SpotQuote } from "../types.js";

/**
 * Birdeye token overview by mint address.
 * Requires BIRDEYE_API_KEY for most environments.
 */
export async function getSpotByMint(mint: string): Promise<SpotQuote> {
  if (!config.birdeye.apiKey) {
    throw new Error(
      "Birdeye: set BIRDEYE_API_KEY (or use dexscreener provider instead)",
    );
  }
  const url = `${config.birdeye.baseUrl}/defi/token_overview?address=${encodeURIComponent(mint)}`;
  const data = await fetchJson<{
    success: boolean;
    data?: {
      address: string;
      symbol: string;
      name: string;
      price?: number;
      priceChange24hPercent?: number;
      v24hUSD?: number;
      mc?: number;
      liquidity?: number;
      supply?: number;
    };
  }>(url, {
    headers: {
      "X-API-KEY": config.birdeye.apiKey,
      "x-chain": "solana",
    },
  });

  const row = data.data;
  if (!row?.price) {
    throw new Error(`Birdeye: no overview for ${mint}`);
  }

  return {
    provider: "birdeye",
    id: row.address,
    symbol: row.symbol,
    name: row.name,
    priceUsd: row.price,
    change24hPct: row.priceChange24hPercent,
    volume24hUsd: row.v24hUSD,
    marketCapUsd: row.mc,
    liquidityUsd: row.liquidity,
    circulatingSupply: row.supply,
    asOf: new Date().toISOString(),
  };
}
