export type Interval = "1h" | "1d";

export interface SpotQuote {
  provider: string;
  id: string;
  symbol: string;
  name?: string;
  priceUsd: number;
  change24hPct?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  circulatingSupply?: number;
  liquidityUsd?: number;
  asOf: string;
}

export interface OhlcBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OhlcSeries {
  provider: string;
  id: string;
  symbol: string;
  interval: Interval;
  bars: OhlcBar[];
}

export interface PerpsQuote {
  provider: string;
  symbol: string;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  maxLeverage?: number;
  asOf: string;
}

export interface ProviderError extends Error {
  provider: string;
  status?: number;
}
