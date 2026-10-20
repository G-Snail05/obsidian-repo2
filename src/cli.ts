#!/usr/bin/env node
import { Command } from "commander";
import {
  getEthBalance,
  getGasOracle,
  getOhlc,
  getPerps,
  getSpot,
  getTxStatus,
  type SpotProvider,
} from "./index.js";
import fs from "node:fs";
import { DEFAULT_ALERTS_PATH, loadAlerts, newAlertId, saveAlerts, type Alert } from "./watch/alerts.js";
import { selfTest, watchConfig, Watcher } from "./watch/watcher.js";

const program = new Command();
program
  .name("obsidian-market")
  .description("Obsidian Division shared market-data CLI")
  .version("0.1.1");

program
  .command("spot")
  .argument("<query>", "symbol, coingecko id, or SOL mint")
  .option(
    "-p, --provider <name>",
    "coingecko | dexscreener | birdeye | auto",
    "auto",
  )
  .action(async (query: string, opts: { provider: string }) => {
    const quote = await getSpot(query, opts.provider as SpotProvider);
    console.log(JSON.stringify(quote, null, 2));
  });

program
  .command("ohlc")
  .argument("<query>", "symbol or coingecko id")
  .option("-i, --interval <interval>", "1h | 1d", "1d")
  .action(async (query: string, opts: { interval: string }) => {
    if (opts.interval !== "1h" && opts.interval !== "1d") {
      throw new Error("interval must be 1h or 1d");
    }
    const series = await getOhlc(query, opts.interval);
    console.log(JSON.stringify(series, null, 2));
  });

program
  .command("perps")
  .argument("<symbol>", "Hyperliquid coin e.g. ETH, BTC, SOL")
  .action(async (symbol: string) => {
    const quote = await getPerps(symbol);
    console.log(JSON.stringify(quote, null, 2));
  });

const eth = program.command("eth").description("Etherscan Ethereum helpers");

eth
  .command("balance")
  .argument("<address>", "0x address")
  .action(async (address: string) => {
    console.log(JSON.stringify(await getEthBalance(address), null, 2));
  });

eth
  .command("gas")
  .description("Current gas oracle")
  .action(async () => {
    console.log(JSON.stringify(await getGasOracle(), null, 2));
  });

eth
  .command("tx")
  .argument("<hash>", "transaction hash")
  .action(async (hash: string) => {
    console.log(JSON.stringify(await getTxStatus(hash), null, 2));
  });

program
  .command("watch")
  .description("Long-running price + Aave HF alert watcher (posts to WEBHOOK_URL; dry-run if unset)")
  .option("--once", "self-test: check feeds, HF, alerts file, print a sample payload, exit")
  .option("--send", "with --once: actually send the self-test heartbeat")
  .option("--status", "print the running watcher's status file")
  .action(async (opts: { once?: boolean; send?: boolean; status?: boolean }) => {
    const c = watchConfig();
    if (opts.status) {
      if (!fs.existsSync(c.statusFile)) throw new Error(`no status file at ${c.statusFile}`);
      console.log(fs.readFileSync(c.statusFile, "utf8"));
      return;
    }
    if (opts.once) {
      console.log(JSON.stringify(await selfTest(c, !!opts.send), null, 2));
      process.exit(0);
    }
    new Watcher(c).start();
  });

const alert = program.command("alert").description(`Manage price alert levels (${DEFAULT_ALERTS_PATH})`);

function mutate(fn: (alerts: Alert[]) => string) {
  const data = loadAlerts();
  const msg = fn(data.alerts);
  saveAlerts(data);
  console.log(msg);
}
function find(alerts: Alert[], id: string) {
  const a = alerts.find((x) => x.id === id);
  if (!a) throw new Error(`no alert with id ${id}`);
  return a;
}

alert
  .command("add")
  .argument("<symbol>", "e.g. ZEC")
  .argument("<op>", "above | below")
  .argument("<level>", "price level in USD")
  .option("--note <note>", "free-text note sent with the alert")
  .option("--cooldown <min>", "minutes between repeat fires", "30")
  .option("--once", "one-shot: disable after first fire")
  .option("--id <id>", "custom id")
  .action((symbol: string, op: string, level: string, o: { note?: string; cooldown: string; once?: boolean; id?: string }) => {
    if (op !== "above" && op !== "below") throw new Error("op must be above or below");
    const a: Alert = { id: "", symbol: symbol.toUpperCase(), op, level: Number(level),
      cooldownMin: Number(o.cooldown), oneShot: !!o.once, enabled: true };
    if (o.note) a.note = o.note;
    a.id = o.id ?? newAlertId(a);
    mutate((alerts) => { alerts.push(a); return `added ${JSON.stringify(a)}`; });
  });

alert.command("list").option("--json", "raw JSON").action((o: { json?: boolean }) => {
  const { alerts } = loadAlerts();
  if (o.json) return console.log(JSON.stringify(alerts, null, 2));
  if (!alerts.length) return console.log("(no alerts)");
  for (const a of alerts)
    console.log(`${a.enabled ? "on " : "off"}  ${a.id}  ${a.symbol} ${a.op} ${a.level}  cd=${a.cooldownMin}m${a.oneShot ? " once" : ""}${a.note ? `  # ${a.note}` : ""}`);
});

alert.command("remove").argument("<id>").action((id: string) =>
  mutate((alerts) => { find(alerts, id); alerts.splice(alerts.findIndex((x) => x.id === id), 1); return `removed ${id}`; }));
alert.command("enable").argument("<id>").action((id: string) =>
  mutate((alerts) => { find(alerts, id).enabled = true; return `enabled ${id}`; }));
alert.command("disable").argument("<id>").action((id: string) =>
  mutate((alerts) => { find(alerts, id).enabled = false; return `disabled ${id}`; }));

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
