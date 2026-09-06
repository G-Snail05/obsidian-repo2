import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  coingecko: {
    apiKey: process.env.COINGECKO_API_KEY?.trim() || undefined,
    baseUrl:
      process.env.COINGECKO_BASE_URL?.trim() ||
      "https://api.coingecko.com/api/v3",
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY?.trim() || undefined,
    baseUrl:
      process.env.BIRDEYE_BASE_URL?.trim() || "https://public-api.birdeye.so",
  },
  dexscreener: {
    baseUrl:
      process.env.DEXSCREENER_BASE_URL?.trim() ||
      "https://api.dexscreener.com/latest/dex",
  },
  hyperliquid: {
    baseUrl:
      process.env.HYPERLIQUID_BASE_URL?.trim() ||
      "https://api.hyperliquid.xyz",
  },
  timeoutMs: num("REQUEST_TIMEOUT_MS", 15_000),
};
