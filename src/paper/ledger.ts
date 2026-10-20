import fs from "node:fs";
import path from "node:path";

export type Side = "long" | "short";
export interface Quote { bid: number; ask: number; at: number }
export type PriceFn = (symbol: string) => Promise<Quote>;

export interface PaperConfig {
  startingBalance: number;
  riskPct: number;        // % of equity risked per trade
  maxOpen: number;        // open + pending positions
  dailyHaltPct: number;   // halt once today's realized loss >= this % of start-of-day equity
  minRR: number;          // net reward:risk after round-trip taker fees
  takerFeePct: number;    // per side, %
  slippageBps: number;    // applied against you on every fill
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  status: "pending" | "open" | "closed" | "cancelled";
  orderType: "market" | "limit";
  limitPrice?: number;
  entry?: number;          // actual fill incl. slippage
  plannedEntry: number;
  stop: number;
  target: number;
  qty: number;
  riskUsd: number;         // planned $ at risk incl. fees
  rrNet: number;
  thesis: string;
  invalidation: string;
  confidence: number;
  createdAt: string;
  openedAt?: string;
  entryFee?: number;
  exit?: number;
  exitFee?: number;
  closedAt?: string;
  closeReason?: "stop" | "target" | "manual";
  pnl?: number;            // net of all fees
  r?: number;              // pnl / riskUsd
}

export interface Ledger {
  version: 1;
  config: PaperConfig;
  balance: number;         // realized cash equity
  positions: Position[];
  seq: number;
}

export const DEFAULT_CONFIG: PaperConfig = {
  startingBalance: 10_000, riskPct: 1, maxOpen: 3, dailyHaltPct: 3, minRR: 2, takerFeePct: 0.6, slippageBps: 5,
};

function envNum(name: string, fb: number) {
  const v = process.env[name]; const n = Number(v);
  return v && Number.isFinite(n) ? n : fb;
}
export function configFromEnv(): PaperConfig {
  return {
    startingBalance: envNum("PAPER_START_BALANCE", DEFAULT_CONFIG.startingBalance),
    riskPct: envNum("PAPER_RISK_PCT", DEFAULT_CONFIG.riskPct),
    maxOpen: envNum("PAPER_MAX_OPEN", DEFAULT_CONFIG.maxOpen),
    dailyHaltPct: envNum("PAPER_DAILY_HALT_PCT", DEFAULT_CONFIG.dailyHaltPct),
    minRR: envNum("PAPER_MIN_RR", DEFAULT_CONFIG.minRR),
    takerFeePct: envNum("PAPER_TAKER_FEE_PCT", DEFAULT_CONFIG.takerFeePct),
    slippageBps: envNum("PAPER_SLIPPAGE_BPS", DEFAULT_CONFIG.slippageBps),
  };
}

export function paperDir() {
  return process.env.PAPER_DIR?.trim() || path.resolve(process.cwd(), ".paper");
}

export function ukDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const round = (n: number, dp = 8) => Math.round(n * 10 ** dp) / 10 ** dp;

export class Rejected extends Error {}

export interface OpenInput {
  symbol: string; side: Side; entry: "market" | number; stop: number; target: number;
  thesis: string; invalidation: string; confidence: number;
}

export class PaperBook {
  readonly file: string;
  readonly journalFile: string;
  constructor(private dir = paperDir(), private now: () => Date = () => new Date()) {
    this.file = path.join(dir, "ledger.json");
    this.journalFile = path.join(dir, "journal.jsonl");
  }

  load(): Ledger {
    if (!fs.existsSync(this.file)) {
      const cfg = configFromEnv();
      return { version: 1, config: cfg, balance: cfg.startingBalance, positions: [], seq: 0 };
    }
    const l = JSON.parse(fs.readFileSync(this.file, "utf8")) as Ledger;
    // env overrides config (except starting balance, fixed at creation)
    const env = configFromEnv();
    l.config = { ...env, startingBalance: l.config.startingBalance };
    return l;
  }
  save(l: Ledger) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
    fs.renameSync(tmp, this.file);
  }
  journal(event: string, data: Record<string, unknown>) {
    fs.mkdirSync(this.dir, { recursive: true });
    const d = this.now();
    fs.appendFileSync(this.journalFile, JSON.stringify({ time: d.toISOString(), ukDay: ukDay(d), event, ...data }) + "\n");
  }
  readJournal(): Record<string, unknown>[] {
    if (!fs.existsSync(this.journalFile)) return [];
    return fs.readFileSync(this.journalFile, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
  }

  private fee(cfg: PaperConfig, notional: number) { return notional * cfg.takerFeePct / 100; }
  private slip(cfg: PaperConfig, px: number, against: "up" | "down") {
    const s = cfg.slippageBps / 10_000; return against === "up" ? px * (1 + s) : px * (1 - s);
  }
  /** Fill price when entering/exiting. Long buys at ask, sells at bid; short the reverse. */
  fillPrice(cfg: PaperConfig, side: Side, action: "enter" | "exit", q: Quote) {
    const buying = (side === "long") === (action === "enter");
    return buying ? this.slip(cfg, q.ask, "up") : this.slip(cfg, q.bid, "down");
  }

  /** Net R:R and per-unit risk after round-trip taker fees + slippage. */
  economics(cfg: PaperConfig, side: Side, entry: number, stop: number, target: number) {
    const f = cfg.takerFeePct / 100, s = cfg.slippageBps / 10_000;
    const dir = side === "long" ? 1 : -1;
    const stopFill = stop * (1 - dir * s), targetFill = target * (1 - dir * s);
    const riskPerUnit = dir * (entry - stopFill) + f * (entry + stopFill);
    const rewardPerUnit = dir * (targetFill - entry) - f * (entry + targetFill);
    return { riskPerUnit, rewardPerUnit, rr: rewardPerUnit / riskPerUnit };
  }

  equityAtDayStart(l: Ledger, day = ukDay(this.now())) {
    return l.balance - this.realizedOn(l, day);
  }
  realizedOn(l: Ledger, day: string) {
    return l.positions.filter((p) => p.status === "closed" && p.closedAt && ukDay(new Date(p.closedAt)) === day)
      .reduce((a, p) => a + (p.pnl ?? 0), 0);
  }
  haltedToday(l: Ledger) {
    const day = ukDay(this.now());
    const loss = -this.realizedOn(l, day);
    const lim = this.equityAtDayStart(l, day) * l.config.dailyHaltPct / 100;
    return { halted: loss >= lim - 1e-9, loss, limit: lim };
  }

  async open(inp: OpenInput, price: PriceFn): Promise<Position> {
    const l = this.load(); const cfg = l.config;
    const reject = (why: string): never => {
      this.journal("rejected", { input: inp, reason: why });
      throw new Rejected(`REJECTED: ${why}`);
    };
    const sym = inp.symbol.toUpperCase();
    if (inp.side !== "long" && inp.side !== "short") reject(`side must be long or short`);
    if (!inp.thesis?.trim()) reject("thesis is required");
    if (!inp.invalidation?.trim()) reject("invalidation is required");
    if (!Number.isInteger(inp.confidence) || inp.confidence < 1 || inp.confidence > 5) reject("confidence must be an integer 1-5");
    for (const [k, v] of [["stop", inp.stop], ["target", inp.target]] as const)
      if (!Number.isFinite(v) || v <= 0) reject(`${k} must be a positive number`);
    if (inp.entry !== "market" && (!Number.isFinite(inp.entry) || inp.entry <= 0)) reject("entry must be 'market' or a positive limit price");

    const active = l.positions.filter((p) => p.status === "open" || p.status === "pending");
    if (active.length >= cfg.maxOpen) reject(`max ${cfg.maxOpen} open/pending positions already (${active.map((p) => p.id).join(", ")})`);
    const h = this.haltedToday(l);
    if (h.halted) reject(`daily halt: today's realized loss $${h.loss.toFixed(2)} >= ${cfg.dailyHaltPct}% limit $${h.limit.toFixed(2)} (UK day ${ukDay(this.now())})`);

    const q = await price(sym);
    const market = inp.entry === "market";
    const entry = market ? this.fillPrice(cfg, inp.side, "enter", q) : (inp.entry as number);
    const dir = inp.side === "long" ? 1 : -1;
    if (dir * (inp.stop - entry) >= 0) reject(`stop ${inp.stop} must be ${inp.side === "long" ? "below" : "above"} entry ${round(entry, 4)}`);
    if (dir * (inp.target - entry) <= 0) reject(`target ${inp.target} must be ${inp.side === "long" ? "above" : "below"} entry ${round(entry, 4)}`);
    if (!market) {
      const mkt = this.fillPrice(cfg, inp.side, "enter", q);
      if (dir * (entry - mkt) >= 0) reject(`limit ${entry} is already marketable (would fill at ${round(mkt, 4)}); use --entry market`);
    }
    const e = this.economics(cfg, inp.side, entry, inp.stop, inp.target);
    if (e.rewardPerUnit <= 0 || e.rr < cfg.minRR - 1e-9)
      reject(`reward:risk after fees is ${e.rr.toFixed(2)}:1, below the ${cfg.minRR}:1 minimum (fee ${cfg.takerFeePct}%/side, slippage ${cfg.slippageBps}bps)`);

    const riskUsd = l.balance * cfg.riskPct / 100;
    const qty = round(riskUsd / e.riskPerUnit, 8);
    const notional = qty * entry;
    if (notional + this.fee(cfg, notional) > l.balance * 1.0 + 1e-9)
      reject(`position notional $${notional.toFixed(2)} exceeds equity $${l.balance.toFixed(2)} (stop too tight; no leverage)`);

    const now = this.now().toISOString();
    const p: Position = {
      id: `P${++l.seq}`, symbol: sym, side: inp.side, status: market ? "open" : "pending",
      orderType: market ? "market" : "limit", plannedEntry: round(entry, 8), stop: inp.stop, target: inp.target,
      qty, riskUsd: round(riskUsd, 2), rrNet: round(e.rr, 3), thesis: inp.thesis, invalidation: inp.invalidation,
      confidence: inp.confidence, createdAt: now,
    };
    if (!market) p.limitPrice = entry;
    if (market) { p.entry = round(entry, 8); p.entryFee = round(this.fee(cfg, notional), 4); p.openedAt = now; }
    l.positions.push(p);
    this.save(l);
    this.journal(market ? "opened" : "limit_placed", { position: p, quote: q });
    return p;
  }

  /** Close at market (manual) or at trigger. Fees deducted, PnL realized. */
  closeAt(l: Ledger, p: Position, q: Quote, reason: Position["closeReason"]) {
    const cfg = l.config;
    const exit = this.fillPrice(cfg, p.side, "exit", q);
    const dir = p.side === "long" ? 1 : -1;
    const exitFee = this.fee(cfg, exit * p.qty);
    const pnl = dir * (exit - p.entry!) * p.qty - (p.entryFee ?? 0) - exitFee;
    Object.assign(p, { status: "closed", exit: round(exit, 8), exitFee: round(exitFee, 4), closedAt: this.now().toISOString(),
      closeReason: reason, pnl: round(pnl, 2), r: round(pnl / p.riskUsd, 3) });
    l.balance = round(l.balance + pnl, 2);
  }

  async close(id: string, price: PriceFn): Promise<Position> {
    const l = this.load();
    const p = l.positions.find((x) => x.id === id.toUpperCase());
    if (!p) throw new Error(`no position ${id}`);
    if (p.status === "pending") {
      p.status = "cancelled"; p.closedAt = this.now().toISOString();
      this.save(l); this.journal("cancelled", { position: p }); return p;
    }
    if (p.status !== "open") throw new Error(`${id} is ${p.status}`);
    const q = await price(p.symbol);
    this.closeAt(l, p, q, "manual");
    this.save(l);
    this.journal("closed", { position: p, quote: q });
    return p;
  }

  /** Called by the watcher: fill pending limits, close on stop/target. Returns events. */
  async check(price: PriceFn): Promise<{ event: "filled" | "stop" | "target"; position: Position }[]> {
    const l = this.load();
    const live = l.positions.filter((p) => p.status === "open" || p.status === "pending");
    if (!live.length) return [];
    const quotes = new Map<string, Quote>();
    for (const s of new Set(live.map((p) => p.symbol))) quotes.set(s, await price(s));
    const out: { event: "filled" | "stop" | "target"; position: Position }[] = [];
    for (const p of live) {
      const q = quotes.get(p.symbol)!;
      const long = p.side === "long";
      if (p.status === "pending") {
        const px = long ? q.ask : q.bid;
        if (long ? px <= p.limitPrice! : px >= p.limitPrice!) {
          const fill = this.fillPrice(l.config, p.side, "enter", { ...q, ask: Math.min(q.ask, p.limitPrice!), bid: Math.max(q.bid, p.limitPrice!) });
          Object.assign(p, { status: "open", entry: round(fill, 8), entryFee: round(this.fee(l.config, fill * p.qty), 4), openedAt: this.now().toISOString() });
          out.push({ event: "filled", position: p });
          this.journal("filled", { position: p, quote: q });
        }
        continue;
      }
      const exitSide = long ? q.bid : q.ask;
      const hitStop = long ? exitSide <= p.stop : exitSide >= p.stop;
      const hitTarget = long ? exitSide >= p.target : exitSide <= p.target;
      if (hitStop || hitTarget) {
        const reason = hitStop ? "stop" : "target";
        this.closeAt(l, p, q, reason);
        out.push({ event: reason, position: p });
        this.journal(`auto_${reason}`, { position: p, quote: q });
      }
    }
    if (out.length) this.save(l);
    return out;
  }

  stats(l = this.load(), quotes?: Map<string, Quote>) {
    const closed = l.positions.filter((p) => p.status === "closed");
    const wins = closed.filter((p) => (p.pnl ?? 0) > 0);
    const rs = closed.map((p) => p.r ?? 0);
    const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    const winRate = closed.length ? wins.length / closed.length : 0;
    const avgWin = wins.length ? wins.reduce((a, p) => a + p.pnl!, 0) / wins.length : 0;
    const losses = closed.filter((p) => (p.pnl ?? 0) <= 0);
    const avgLoss = losses.length ? losses.reduce((a, p) => a + p.pnl!, 0) / losses.length : 0;
    const expectancyUsd = winRate * avgWin + (1 - winRate) * avgLoss;
    // drawdown on realized equity curve
    let eq = l.config.startingBalance, peak = eq, maxDd = 0;
    for (const p of [...closed].sort((a, b) => a.closedAt!.localeCompare(b.closedAt!))) {
      eq += p.pnl ?? 0; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (peak - eq) / peak);
    }
    const open = l.positions.filter((p) => p.status === "open");
    const pending = l.positions.filter((p) => p.status === "pending");
    const openRiskUsd = [...open, ...pending].reduce((a, p) => a + p.riskUsd, 0);
    let unrealized: number | null = null;
    if (quotes) unrealized = open.reduce((a, p) => {
      const q = quotes.get(p.symbol); if (!q) return a;
      const ex = p.side === "long" ? q.bid : q.ask;
      return a + (p.side === "long" ? 1 : -1) * (ex - p.entry!) * p.qty - (p.entryFee ?? 0);
    }, 0);
    const grad = { closedTrades: closed.length >= 30, positiveAvgR: avgR > 0, drawdownUnder10pct: maxDd < 0.10 };
    const h = this.haltedToday(l);
    return {
      trades: closed.length, wins: wins.length, losses: losses.length,
      winRate: round(winRate * 100, 1), avgR: round(avgR, 3), expectancyR: round(avgR, 3), expectancyUsd: round(expectancyUsd, 2),
      totalPnl: round(l.balance - l.config.startingBalance, 2), equity: l.balance,
      unrealizedPnl: unrealized === null ? null : round(unrealized, 2),
      maxDrawdownPct: round(maxDd * 100, 2), openPositions: open.length, pendingOrders: pending.length,
      openRiskUsd: round(openRiskUsd, 2), openRiskPct: round(openRiskUsd / l.balance * 100, 2),
      haltedToday: h.halted, todayRealized: round(-h.loss, 2),
      graduation: { ready: grad.closedTrades && grad.positiveAvgR && grad.drawdownUnder10pct, ...grad },
      config: l.config,
    };
  }

  reset() {
    const l = this.load();
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + `.bak-${Date.now()}`);
    this.journal("reset", { previousBalance: l.balance, trades: l.positions.length });
  }
}

/** Live Coinbase Exchange public best bid/ask. */
export const coinbaseQuote: PriceFn = async (symbol) => {
  const r = await fetch(`https://api.exchange.coinbase.com/products/${symbol.toUpperCase()}-USD/ticker`,
    { headers: { "user-agent": "obsidian-market" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`coinbase ticker ${symbol}-USD HTTP ${r.status}`);
  const j = (await r.json()) as { bid: string; ask: string };
  const bid = Number(j.bid), ask = Number(j.ask);
  if (!(bid > 0 && ask > 0)) throw new Error(`coinbase ticker ${symbol}-USD: no bid/ask`);
  return { bid, ask, at: Date.now() };
};

/** For smoke tests: PAPER_MOCK_PRICES='{"ETH":[2380,2381]}' or a path to such a JSON file. */
export function mockQuoteFromEnv(): PriceFn | null {
  const v = process.env.PAPER_MOCK_PRICES?.trim();
  if (!v) return null;
  return async (s) => {
    const m = JSON.parse(v.startsWith("{") ? v : fs.readFileSync(v, "utf8")) as Record<string, [number, number]>;
    const x = m[s.toUpperCase()]; if (!x) throw new Error(`no mock price for ${s}`);
    return { bid: x[0], ask: x[1], at: Date.now() };
  };
}
export const priceFn = (): PriceFn => mockQuoteFromEnv() ?? coinbaseQuote;
