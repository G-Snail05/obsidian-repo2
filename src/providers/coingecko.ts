import { config } from "../config.js";
import { fetchJson } from "../http.js";
import type { Interval, OhlcSeries, SpotQuote } from "../types.js";

const SYMBOL_TO_ID: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  doge: "dogecoin",
  xrp: "ripple",
  ada: "cardano",
  avax: "avalanche-2",
  link: "chainlink",
  matic: "matic-network",
  pol: "polygon-ecosystem-token",
};

export function resolveCoinGeckoId(input: string): string {
  const key = input.trim().toLowerCase();
  return SYMBOL_TO_ID[key] ?? key;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {};
  if (config.coingecko.apiKey) {
    h["x-cg-demo-api-key"] = config.coingecko.apiKey;
  }
  return h;
}

interface MarketRow {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h?: number;
  total_volume?: number;
  market_cap?: number;
  fully_diluted_valuation?: number;
  circulating_supply?: number;
}

export async function getSpot(idOrSymbol: string): Promise<SpotQuote> {
  const id = resolveCoinGeckoId(idOrSymbol);
  const url =
    `${config.coingecko.baseUrl}/coins/markets` +
    `?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`;
  const rows = await fetchJson<MarketRow[]>(url, { headers: headers() });
  const row = rows[0];
  if (!row) {
    throw new Error(`CoinGecko: no market data for ${id}`);
  }
  return {
    provider: "coingecko",
    id: row.id,
    symbol: row.symbol.toUpperCase(),
    name: row.name,
    priceUsd: row.current_price,
    change24hPct: row.price_change_percentage_24h,
    volume24hUsd: row.total_volume,
    marketCapUsd: row.market_cap,
    fdvUsd: row.fully_diluted_valuation,
    circulatingSupply: row.circulating_supply,
    asOf: new Date().toISOString(),
  };
}

export async function getOhlc(
  idOrSymbol: string,
  interval: Interval,
): Promise<OhlcSeries> {
  const id = resolveCoinGeckoId(idOrSymbol);
  // CoinGecko: days=1 ~ hourly-ish; days=30/90 for daily. Use 1 for 1h, 30 for 1d.
  const days = interval === "1h" ? 1 : 30;
  const url = `${config.coingecko.baseUrl}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=${days}`;
  const raw = await fetchJson<number[][]>(url, { headers: headers() });
  const bars = raw.map(([t, o, h, l, c]) => ({
    time: new Date(t).toISOString(),
    open: o,
    high: h,
    low: l,
    close: c,
  }));
  const spot = await getSpot(id).catch(() => null);
  return {
    provider: "coingecko",
    id,
    symbol: spot?.symbol ?? idOrSymbol.toUpperCase(),
    interval,
    bars,
  };
}
