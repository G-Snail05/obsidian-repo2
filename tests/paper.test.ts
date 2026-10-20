import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PaperBook, Rejected, type Quote } from "../src/paper/ledger.js";

for (const k of Object.keys(process.env)) if (k.startsWith("PAPER_")) delete process.env[k];
let px: Record<string, [number, number]> = {};
const price = async (s: string): Promise<Quote> => ({ bid: px[s][0], ask: px[s][1], at: 0 });
let clock = new Date("2026-10-20T10:00:00Z");
const book = () => new PaperBook(fs.mkdtempSync(path.join(os.tmpdir(), "paper-")), () => clock);
const base = { symbol: "ETH", side: "long" as const, entry: "market" as const, stop: 2300, target: 2700,
  thesis: "reclaim", invalidation: "lose 2300", confidence: 3 };

test("accepted market long: buys at ask, sized to 1% risk incl. fees", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  const p = await b.open(base, price);
  assert.equal(p.status, "open");
  assert.ok(p.entry! > 2381);
  assert.equal(p.riskUsd, 100);
  const e = b.economics(b.load().config, "long", p.entry!, p.stop, p.target);
  assert.ok(Math.abs(p.qty * e.riskPerUnit - 100) < 0.01);
});

test("rejects R:R below 2 after fees even if gross is ~2", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  await assert.rejects(b.open({ ...base, stop: 2340, target: 2462 }, price), (e: Error) => e instanceof Rejected && /reward:risk/.test(e.message));
});

test("rejects missing thesis, bad confidence, wrong-side stop", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  await assert.rejects(b.open({ ...base, thesis: " " }, price), /thesis/);
  await assert.rejects(b.open({ ...base, confidence: 6 }, price), /confidence/);
  await assert.rejects(b.open({ ...base, stop: 2400 }, price), /stop .* below/);
});

test("max 3 open positions", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  for (let i = 0; i < 3; i++) await b.open(base, price);
  await assert.rejects(b.open(base, price), /max 3/);
});

test("auto-stop, auto-target, daily halt at 3% and UK day rollover", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  const a = await b.open(base, price);
  px = { ETH: [2299, 2300] };
  let ev = await b.check(price);
  assert.equal(ev[0].event, "stop"); assert.ok(ev[0].position.r! < -0.95 && ev[0].position.r! > -1.1);
  // two more losers -> ~3% loss -> halt
  for (let i = 0; i < 2; i++) { px = { ETH: [2380, 2381] }; await b.open(base, price); px = { ETH: [2290, 2291] }; await b.check(price); }
  const s = b.stats();
  assert.ok(s.todayRealized <= -300 * 0.97);
  px = { ETH: [2380, 2381] };
  if (s.haltedToday) await assert.rejects(b.open(base, price), /daily halt/);
  else { // slippage made losses a bit > 1R each; must be halted
    assert.fail(`expected halt, today=${s.todayRealized}`);
  }
  clock = new Date("2026-10-21T00:30:00+01:00"); // next UK day
  const t = await b.open(base, price);
  px = { ETH: [2701, 2702] };
  ev = await b.check(price);
  assert.equal(ev[0].event, "target"); assert.ok(ev[0].position.r! > 2);
  clock = new Date("2026-10-20T10:00:00Z");
  assert.ok(a.id && t.id);
});

test("limit order fills when touched; short works; stats + graduation flag", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  await assert.rejects(b.open({ ...base, entry: 2390 }, price), /marketable/);
  const p = await b.open({ ...base, entry: 2350, stop: 2290, target: 2600 }, price);
  assert.equal(p.status, "pending");
  px = { ETH: [2349, 2350] };
  assert.equal((await b.check(price))[0].event, "filled");
  const sh = await b.open({ ...base, side: "short", stop: 2420, target: 2100 }, price);
  assert.equal(sh.status, "open"); assert.ok(sh.entry! < 2349);
  px = { ETH: [2099, 2100] };
  const ev = await b.check(price);
  assert.equal(ev.find((e) => e.position.id === sh.id)!.event, "target");
  const st = b.stats();
  assert.equal(st.trades, 2); // long limit got stopped on the same drop assert.equal(st.graduation.ready, false); assert.equal(st.graduation.closedTrades, false);
  assert.equal(st.openPositions, 0); assert.equal(st.openRiskUsd, 0); assert.equal(st.winRate, 50);
  assert.ok(b.readJournal().some((j) => j.event === "auto_target"));
});
