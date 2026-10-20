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

test("limit entry: touch does not fill, trade-through does, at the level with maker fee", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  await assert.rejects(b.open({ ...base, entry: 2390 }, price), /marketable/);
  const p = await b.open({ ...base, entry: 2350, stop: 2290, target: 2600 }, price);
  assert.equal(p.status, "pending");
  px = { ETH: [2349, 2350] };             // touch
  assert.equal((await b.check(price)).length, 0);
  px = { ETH: [2349.5, 2349.8] };         // ask 2349.8 not < 2350*(1-1bp)=2349.765
  assert.equal((await b.check(price)).length, 0);
  px = { ETH: [2349.5, 2349.7] };         // through
  const ev = await b.check(price);
  assert.equal(ev[0].event, "filled");
  assert.equal(ev[0].position.entry, 2350);
  assert.ok(Math.abs(ev[0].position.entryFee! - 2350 * ev[0].position.qty * 0.004) < 1e-3);
});

test("target: touch does not close; trade-through closes at target, maker fee, no slippage", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  const p = await b.open(base, price);
  px = { ETH: [2700, 2701] };
  assert.equal((await b.check(price)).length, 0);
  px = { ETH: [2700.5, 2701] };            // bid > 2700*(1+1bp)=2700.27
  const ev = await b.check(price);
  assert.equal(ev[0].event, "target");
  const c = ev[0].position;
  assert.equal(c.exit, 2700);
  assert.ok(Math.abs(c.exitFee! - 2700 * p.qty * 0.004) < 1e-3);
});

test("stop exit is taker + slippage", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  const p = await b.open(base, price);
  px = { ETH: [2299, 2300] };
  const c = (await b.check(price))[0].position;
  assert.ok(Math.abs(c.exit! - 2299 * (1 - 0.0005)) < 1e-6);
  assert.ok(Math.abs(c.exitFee! - c.exit! * p.qty * 0.006) < 1e-3);
});

test("short: limit trades through via bid, target via ask", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  const sh = await b.open({ ...base, side: "short", entry: 2400, stop: 2440, target: 2200 }, price);
  px = { ETH: [2400, 2401] }; assert.equal((await b.check(price)).length, 0);
  px = { ETH: [2400.5, 2401] }; assert.equal((await b.check(price))[0].event, "filled");
  px = { ETH: [2199, 2200] }; assert.equal((await b.check(price)).length, 0);
  px = { ETH: [2199, 2199.7] };
  const c = (await b.check(price))[0].position;
  assert.equal(c.closeReason, "target"); assert.equal(c.exit, 2200); assert.ok(c.r! > 2);
  const st = b.stats();
  assert.equal(st.trades, 1); assert.equal(st.graduation.ready, false); assert.equal(st.openRiskUsd, 0);
  assert.ok(b.readJournal().some((j) => j.event === "auto_target"));
  assert.ok(sh.id);
});

test("fee mix: tight setup fails as market (taker) but passes as limit (maker)", async () => {
  px = { ETH: [2380, 2381] }; const b = book();
  await assert.rejects(b.open({ ...base, entry: "market", stop: 2330, target: 2560 }, price), /reward:risk/);
  const p = await b.open({ ...base, entry: 2378, stop: 2330, target: 2560 }, price);
  assert.ok(p.rrNet >= 2);
});
