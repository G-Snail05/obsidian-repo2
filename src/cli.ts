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

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
