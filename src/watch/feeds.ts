import WebSocket from "ws";

export interface Tick {
  symbol: string;
  price: number;
  source: "coinbase" | "hyperliquid";
  at: number;
}
type OnTick = (t: Tick) => void;
type Log = (m: string) => void;

export function backoffMs(attempt: number, base = 1000, max = 60_000): number {
  const d = Math.min(max, base * 2 ** attempt);
  return Math.round(d / 2 + Math.random() * (d / 2));
}

export class CoinbaseFeed {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  connected = false;
  lastTickAt?: number;
  constructor(private symbols: string[], private onTick: OnTick, private log: Log,
              private url = "wss://ws-feed.exchange.coinbase.com") {}

  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
  /** Force reconnect (e.g. on staleness). */
  kick() {
    this.ws?.terminate();
  }
  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.attempt = 0;
      this.log(`coinbase connected`);
      ws.send(JSON.stringify({ type: "subscribe", product_ids: this.symbols.map((s) => `${s}-USD`), channels: ["ticker"] }));
    });
    ws.on("message", (buf) => {
      try {
        const m = JSON.parse(buf.toString());
        if (m.type === "ticker" && m.product_id && m.price) {
          const symbol = String(m.product_id).split("-")[0];
          const price = Number(m.price);
          if (Number.isFinite(price)) {
            this.lastTickAt = Date.now();
            this.onTick({ symbol, price, source: "coinbase", at: this.lastTickAt });
          }
        } else if (m.type === "error") this.log(`coinbase error msg: ${m.message} ${m.reason ?? ""}`);
      } catch { /* ignore */ }
    });
    ws.on("error", (e) => this.log(`coinbase ws error: ${e.message}`));
    ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      const d = backoffMs(this.attempt++);
      this.log(`coinbase closed; reconnect in ${d}ms`);
      this.timer = setTimeout(() => this.connect(), d);
    });
  }
}

/** Hyperliquid allMids via POST /info polling (fallback). */
export class HyperliquidPoller {
  private timer?: NodeJS.Timeout;
  private failures = 0;
  active = false;
  lastTickAt?: number;
  lastError?: string;
  constructor(private symbols: string[], private onTick: OnTick, private log: Log,
              private baseUrl = "https://api.hyperliquid.xyz", private intervalMs = 5000) {}

  async pollOnce(): Promise<Tick[]> {
    const r = await fetch(`${this.baseUrl}/info`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }), signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`hyperliquid HTTP ${r.status}`);
    const mids = (await r.json()) as Record<string, string>;
    const at = Date.now();
    const out: Tick[] = [];
    for (const s of this.symbols) {
      const p = Number(mids[s]);
      if (Number.isFinite(p) && p > 0) out.push({ symbol: s, price: p, source: "hyperliquid", at });
    }
    return out;
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.log("hyperliquid fallback ON");
    const loop = async () => {
      if (!this.active) return;
      let wait = this.intervalMs;
      try {
        const ticks = await this.pollOnce();
        this.failures = 0;
        this.lastError = undefined;
        for (const t of ticks) { this.lastTickAt = t.at; this.onTick(t); }
      } catch (e) {
        this.lastError = (e as Error).message;
        wait = Math.max(this.intervalMs, backoffMs(this.failures++));
        this.log(`hyperliquid poll failed: ${this.lastError}`);
      }
      if (this.active) this.timer = setTimeout(loop, wait);
    };
    void loop();
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    this.log("hyperliquid fallback OFF");
  }
}
