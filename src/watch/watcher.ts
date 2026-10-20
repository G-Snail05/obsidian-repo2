import fs from "node:fs";
import path from "node:path";
import { Alert, CrossingEngine, DEFAULT_ALERTS_PATH, loadAlerts, saveAlerts } from "./alerts.js";
import { CoinbaseFeed, HyperliquidPoller, Tick } from "./feeds.js";
import { fetchAccountData, HfMonitor } from "./hf.js";
import { londonTime, makePayload, Notifier } from "./notify.js";
import { PaperBook, priceFn } from "../paper/ledger.js";

function num(name: string, fb: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : fb;
}

export function watchConfig() {
  const stateDir = process.env.WATCH_STATE_DIR?.trim() || path.resolve(process.cwd(), ".watch");
  return {
    symbols: (process.env.WATCH_SYMBOLS || "ZEC,ETH,BTC,NEAR").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    staleSec: num("STALE_SEC", 60),
    alertsFile: DEFAULT_ALERTS_PATH,
    stateDir,
    statusFile: path.join(stateDir, "status.json"),
    dryRunFile: path.join(stateDir, "dry-run.jsonl"),
    heartbeatAt: process.env.HEARTBEAT_AT?.trim() || "09:00",
    hf: {
      user: process.env.AAVE_USER?.trim() || "0x6951099D155c26E4De091Dd0b2675e8dB216B1e0",
      spoke: process.env.AAVE_SPOKE?.trim() || "0x94e7a5dcbe816e498b89ab752661904e2f56c485",
      rpcUrl: process.env.RPC_URL?.trim() || undefined,
      etherscanKey: process.env.ETHERSCAN_API_KEY?.trim() || undefined,
      etherscanBase: process.env.ETHERSCAN_BASE_URL?.trim() || undefined,
      pollMin: num("HF_POLL_MIN", 5),
      thresholds: {
        warn: num("HF_WARN", 1.3),
        critical: num("HF_CRITICAL", 1.2),
        hysteresis: num("HF_HYSTERESIS", 0.02),
        repeatMin: num("HF_REPEAT_MIN", 60),
      },
    },
    webhook: {
      url: process.env.WEBHOOK_URL?.trim() || undefined,
      key: process.env.WEBHOOK_KEY?.trim() || undefined,
      keyHeader: process.env.WEBHOOK_KEY_HEADER?.trim() || undefined,
    },
  };
}
export type WatchConfig = ReturnType<typeof watchConfig>;

export function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

interface Last { price: number; source: string; at: number }

export class Watcher {
  private alerts: Alert[] = [];
  private engine = new CrossingEngine();
  private last = new Map<string, Last>();
  private cbLast = new Map<string, number>();
  private staleFlag = new Map<string, boolean>();
  private cb: CoinbaseFeed;
  private hl: HyperliquidPoller;
  private hfMon: HfMonitor;
  private notifier: Notifier;
  private timers: NodeJS.Timeout[] = [];
  private hfError?: string;
  private hfAt?: number;
  private heartbeatSentFor?: string;
  private startedAt = Date.now();
  private configError?: string;
  private paper = new PaperBook();
  private paperBusy = false;
  private paperError?: string;

  constructor(private c: WatchConfig) {
    fs.mkdirSync(c.stateDir, { recursive: true });
    this.cb = new CoinbaseFeed(c.symbols, (t) => this.onTick(t), log);
    this.hl = new HyperliquidPoller(c.symbols, (t) => this.onTick(t), log);
    this.hfMon = new HfMonitor(c.hf.thresholds);
    this.notifier = new Notifier({ ...c.webhook, log, dryRunFile: c.dryRunFile });
  }

  reloadAlerts() {
    try {
      this.alerts = loadAlerts(this.c.alertsFile).alerts;
      this.engine.sync(this.alerts);
      this.configError = undefined;
      log(`alerts loaded: ${this.alerts.length} (${this.alerts.filter((a) => a.enabled).length} enabled)`);
    } catch (e) {
      this.configError = (e as Error).message;
      log(`alerts.json invalid, keeping last good config (${this.alerts.length} alerts): ${this.configError}`);
    }
  }

  private onTick(t: Tick) {
    if (t.source === "coinbase") this.cbLast.set(t.symbol, t.at);
    else {
      const cbAt = this.cbLast.get(t.symbol);
      if (cbAt && Date.now() - cbAt < this.c.staleSec * 1000) return; // coinbase fresh: ignore fallback
    }
    this.last.set(t.symbol, { price: t.price, source: t.source, at: t.at });
    if (this.staleFlag.get(t.symbol)) {
      this.staleFlag.set(t.symbol, false);
      log(`${t.symbol} fresh again via ${t.source}`);
    }
    for (const f of this.engine.onPrice(this.alerts, t.symbol, t.price)) {
      const a = f.alert;
      log(`ALERT ${a.id} ${a.symbol} ${a.op} ${a.level} @ ${f.price} (${t.source})`);
      void this.notifier.send(makePayload({
        type: "price", alertId: a.id, symbol: a.symbol, price: f.price, level: a.level, op: a.op,
        note: a.note, source: t.source,
      }));
      if (a.oneShot) this.disableAlert(a.id);
    }
  }

  private disableAlert(id: string) {
    try {
      const data = loadAlerts(this.c.alertsFile);
      const a = data.alerts.find((x) => x.id === id);
      if (a) { a.enabled = false; saveAlerts(data, this.c.alertsFile); }
      const mem = this.alerts.find((x) => x.id === id);
      if (mem) mem.enabled = false;
    } catch (e) {
      log(`could not disable one-shot ${id}: ${(e as Error).message}`);
    }
  }

  private checkStale() {
    const now = Date.now();
    const lim = this.c.staleSec * 1000;
    let needFallback = false;
    for (const s of this.c.symbols) {
      const cbAt = this.cbLast.get(s);
      if (!cbAt || now - cbAt > lim) needFallback = true;
      const l = this.last.get(s);
      const stale = !l || now - l.at > lim;
      if (stale && !this.staleFlag.get(s) && now - this.startedAt > lim) {
        this.staleFlag.set(s, true);
        log(`STALE ${s}: no tick for ${this.c.staleSec}s`);
      }
    }
    const cbSilent = !this.cb.lastTickAt || now - this.cb.lastTickAt > lim;
    if (cbSilent && this.cb.connected && now - this.startedAt > lim) {
      log("coinbase silent while connected; forcing reconnect");
      this.cb.kick();
    }
    if (needFallback) this.hl.start();
    else this.hl.stop();
    this.writeStatus();
  }

  private async pollHf() {
    try {
      const d = await fetchAccountData(this.c.hf);
      this.hfAt = Date.now();
      this.hfError = undefined;
      const ev = this.hfMon.update(d.healthFactor);
      log(`HF ${d.healthFactor} (${this.hfMon.level})`);
      if (ev) {
        const t = this.c.hf.thresholds;
        void this.notifier.send(makePayload({
          type: "hf", symbol: "AAVE_V4_HF", price: d.healthFactor,
          level: ev.level === "critical" ? t.critical : t.warn,
          op: "below", note: `HF ${ev.kind}: ${ev.prev} -> ${ev.level}`, source: "aave-v4-spoke",
          alertId: `hf-${ev.level}`, hfState: ev.level,
        }));
      }
    } catch (e) {
      this.hfError = (e as Error).message;
      log(`HF poll failed: ${this.hfError}`);
    }
  }

  status() {
    const now = Date.now();
    const feeds = Object.fromEntries(this.c.symbols.map((s) => {
      const l = this.last.get(s);
      return [s, l ? { price: l.price, source: l.source, ageSec: Math.round((now - l.at) / 1000),
        stale: now - l.at > this.c.staleSec * 1000 } : { stale: true }];
    }));
    return {
      pid: process.pid,
      dryRun: this.notifier.dryRun,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
      updatedLondon: londonTime(new Date(now)),
      coinbaseConnected: this.cb.connected,
      hyperliquidFallback: this.hl.active,
      feeds,
      hf: { value: this.hfMon.lastHf ?? null, state: this.hfMon.level,
        at: this.hfAt ? new Date(this.hfAt).toISOString() : null, error: this.hfError ?? null },
      alerts: { total: this.alerts.length, enabled: this.alerts.filter((a) => a.enabled).length,
        configError: this.configError ?? null },
      paper: { error: this.paperError ?? null },
    };
  }

  private writeStatus() {
    const tmp = this.c.statusFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.status(), null, 2));
    fs.renameSync(tmp, this.c.statusFile);
  }

  private checkHeartbeat() {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    const day = `${g("year")}-${g("month")}-${g("day")}`;
    const hm = `${g("hour")}:${g("minute")}`;
    if (this.heartbeatSentFor === undefined) {
      // don't fire a heartbeat just because we started after the time today
      this.heartbeatSentFor = hm >= this.c.heartbeatAt ? day : "";
      return;
    }
    if (hm >= this.c.heartbeatAt && this.heartbeatSentFor !== day) {
      this.heartbeatSentFor = day;
      this.sendHeartbeat();
    }
  }

  async checkPaper() {
    if (this.paperBusy) return;
    this.paperBusy = true;
    try {
      for (const ev of await this.paper.check(priceFn())) {
        const p = ev.position;
        const msg = ev.event === "filled"
          ? `PAPER ${p.id} ${p.side} ${p.symbol} limit filled @ ${p.entry} qty=${p.qty}`
          : `PAPER ${p.id} ${p.side} ${p.symbol} hit ${ev.event} -> closed @ ${p.exit} pnl=$${p.pnl} (${p.r}R)`;
        log(msg);
        void this.notifier.send(makePayload({ type: "paper", event: ev.event, symbol: p.symbol, price: p.exit ?? p.entry,
          level: ev.event === "stop" ? p.stop : ev.event === "target" ? p.target : p.limitPrice, note: msg, source: "paper",
          positionId: p.id, side: p.side, pnl: p.pnl, r: p.r }));
      }
      this.paperError = undefined;
    } catch (e) {
      if (this.paperError !== (e as Error).message) log(`paper check failed: ${(e as Error).message}`);
      this.paperError = (e as Error).message;
    } finally { this.paperBusy = false; }
  }

  sendHeartbeat() {
    const s = this.status();
    return this.notifier.send(makePayload({ type: "heartbeat", source: "obsidian-market watch",
      note: "daily watcher heartbeat", feeds: s.feeds, hf: s.hf, alerts: s.alerts,
      coinbaseConnected: s.coinbaseConnected, hyperliquidFallback: s.hyperliquidFallback, dryRun: s.dryRun }));
  }

  start() {
    log(`watch starting pid=${process.pid} symbols=${this.c.symbols.join(",")} dryRun=${this.notifier.dryRun} alerts=${this.c.alertsFile}`);
    this.reloadAlerts();
    let debounce: NodeJS.Timeout | undefined;
    fs.watchFile(this.c.alertsFile, { interval: 1000 }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.reloadAlerts(), 200);
    });
    this.cb.start();
    void this.pollHf();
    this.timers.push(setInterval(() => this.checkStale(), 5000));
    this.timers.push(setInterval(() => void this.pollHf(), this.c.hf.pollMin * 60_000));
    this.timers.push(setInterval(() => this.checkHeartbeat(), 30_000));
    this.timers.push(setInterval(() => void this.checkPaper(), Number(process.env.PAPER_POLL_SEC || 5) * 1000));
    this.checkHeartbeat();
    const stop = (sig: string) => {
      log(`received ${sig}, stopping`);
      this.cb.stop(); this.hl.stop();
      this.timers.forEach(clearInterval);
      fs.unwatchFile(this.c.alertsFile);
      process.exit(0);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("uncaughtException", (e) => {
      log(`uncaught: ${e.stack ?? e}`);
      void this.notifier.send(makePayload({ type: "watcher_error", source: "obsidian-market watch", note: String(e.message) }))
        .finally(() => process.exit(1));
    });
  }
}

/** Self-test: one pass over every dependency, then exit. */
export async function selfTest(c: WatchConfig, sendHeartbeat: boolean) {
  const out: Record<string, unknown> = {};
  try { out.alerts = `${loadAlerts(c.alertsFile).alerts.length} alerts valid`; } catch (e) { out.alerts = `INVALID: ${(e as Error).message}`; }
  const cbTicks: Record<string, number> = {};
  await new Promise<void>((resolve) => {
    const feed = new CoinbaseFeed(c.symbols, (t) => {
      cbTicks[t.symbol] = t.price;
      if (Object.keys(cbTicks).length === c.symbols.length) { feed.stop(); resolve(); }
    }, () => {});
    feed.start();
    setTimeout(() => { feed.stop(); resolve(); }, 20_000);
  });
  out.coinbase = Object.fromEntries(c.symbols.map((s) => [s, cbTicks[s] ?? "no tick in 20s"]));
  try {
    const hl = new HyperliquidPoller(c.symbols, () => {}, () => {});
    out.hyperliquid = Object.fromEntries((await hl.pollOnce()).map((t) => [t.symbol, t.price]));
  } catch (e) { out.hyperliquid = `ERROR ${(e as Error).message}`; }
  try {
    const d = await fetchAccountData(c.hf);
    out.hf = { healthFactor: d.healthFactor, avgCollateralFactor: d.avgCollateralFactor,
      activeCollateralCount: d.activeCollateralCount, borrowCount: d.borrowCount,
      state: new HfMonitor(c.hf.thresholds).classify(d.healthFactor), via: c.hf.rpcUrl ? "RPC_URL" : "etherscan proxy" };
  } catch (e) { out.hf = `ERROR ${(e as Error).message}`; }
  out.webhook = c.webhook.url ? "configured" : "dry-run (WEBHOOK_URL unset)";
  const sample = makePayload({ type: "heartbeat", source: "obsidian-market watch --once", note: "self-test",
    feeds: out.coinbase, hf: out.hf });
  out.samplePayload = sample;
  if (sendHeartbeat) {
    const n = new Notifier({ ...c.webhook, log, dryRunFile: c.dryRunFile });
    out.sent = await n.send(sample);
  }
  return out;
}
