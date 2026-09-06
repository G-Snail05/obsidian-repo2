import * as birdeye from "./providers/birdeye.js";
import * as coingecko from "./providers/coingecko.js";
import * as dexscreener from "./providers/dexscreener.js";
import * as hyperliquid from "./providers/hyperliquid.js";
import type { Interval, OhlcSeries, PerpsQuote, SpotQuote } from "./types.js";

export type SpotProvider = "coingecko" | "dexscreener" | "birdeye" | "auto";

export type { Interval, OhlcBar, OhlcSeries, PerpsQuote, SpotQuote } from "./types.js";
export { resolveCoinGeckoId } from "./providers/coingecko.js";

export async function getSpot(
  query: string,
  provider: SpotProvider = "auto",
): Promise<SpotQuote> {
  const q = query.trim();
  if (provider === "coingecko") return coingecko.getSpot(q);
  if (provider === "dexscreener") return dexscreener.getSpot(q);
  if (provider === "birdeye") return birdeye.getSpotByMint(q);

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q)) {
    try {
      return await dexscreener.getSpot(q);
    } catch {
      return birdeye.getSpotByMint(q);
    }
  }
  return coingecko.getSpot(q);
}

export async function getOhlc(
  query: string,
  interval: Interval = "1d",
): Promise<OhlcSeries> {
  return coingecko.getOhlc(query, interval);
}

export async function getPerps(symbol: string): Promise<PerpsQuote> {
  return hyperliquid.getPerps(symbol);
}

export async function getProtocolTvl(_protocol: string): Promise<never> {
  throw new Error("TODO: DefiLlama TVL provider not implemented yet");
}
