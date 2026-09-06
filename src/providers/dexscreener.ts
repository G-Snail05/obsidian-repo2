import { config } from "../config.js";
import { fetchJson } from "../http.js";
import type { SpotQuote } from "../types.js";

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
}

interface DexSearch {
  pairs?: DexPair[];
}

/** Resolve a Solana token mint or symbol via DexScreener search; prefer SOL pairs. */
export async function getSpot(query: string): Promise<SpotQuote> {
  const url = `${config.dexscreener.baseUrl}/search?q=${encodeURIComponent(query)}`;
  const data = await fetchJson<DexSearch>(url);
  const pairs = data.pairs ?? [];
  const sol =
    pairs.find(
      (p) =>
        p.chainId === "solana" &&
        p.quoteToken?.symbol?.toUpperCase() === "SOL" &&
        p.priceUsd,
    ) ??
    pairs.find((p) => p.chainId === "solana" && p.priceUsd) ??
    pairs.find((p) => p.priceUsd);

  if (!sol?.priceUsd) {
    throw new Error(`DexScreener: no priced pair for ${query}`);
  }

  return {
    provider: "dexscreener",
    id: sol.baseToken.address || sol.pairAddress,
    symbol: sol.baseToken.symbol,
    name: sol.baseToken.name,
    priceUsd: Number(sol.priceUsd),
    change24hPct: sol.priceChange?.h24,
    volume24hUsd: sol.volume?.h24,
    marketCapUsd: sol.marketCap,
    fdvUsd: sol.fdv,
    liquidityUsd: sol.liquidity?.usd,
    asOf: new Date().toISOString(),
  };
}
