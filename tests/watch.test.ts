import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrossingEngine, validateAlerts, saveAlerts, loadAlerts, type Alert } from "../src/watch/alerts.js";
import { HfMonitor, decodeAccountData } from "../src/watch/hf.js";
import { buildAuthHeader, makePayload } from "../src/watch/notify.js";

const A = (o: Partial<Alert> = {}): Alert => ({ id: "a", symbol: "ZEC", op: "above", level: 100, cooldownMin: 30, oneShot: false, enabled: true, ...o });
const M = 60_000;

test("above: fires only on crossing, not on every tick beyond", () => {
  const e = new CrossingEngine(); const al = [A({ cooldownMin: 0 })];
  assert.equal(e.onPrice(al, "ZEC", 95, 0).length, 0);
  assert.equal(e.onPrice(al, "ZEC", 101, 1).length, 1);
  assert.equal(e.onPrice(al, "ZEC", 105, 2).length, 0);
  assert.equal(e.onPrice(al, "ZEC", 110, 3).length, 0);
});

test("no fire at startup when price already beyond; fires after re-arm", () => {
  const e = new CrossingEngine(); const al = [A({ cooldownMin: 0 })];
  assert.equal(e.onPrice(al, "ZEC", 120, 0).length, 0);
  assert.equal(e.onPrice(al, "ZEC", 99, 1).length, 0);
  assert.equal(e.onPrice(al, "ZEC", 100, 2).length, 1);
});

test("below alert crossing and re-arm", () => {
  const e = new CrossingEngine(); const al = [A({ op: "below", level: 50, cooldownMin: 0 })];
  e.onPrice(al, "ZEC", 60, 0);
  assert.equal(e.onPrice(al, "ZEC", 49, 1).length, 1);
  assert.equal(e.onPrice(al, "ZEC", 48, 2).length, 0);
  e.onPrice(al, "ZEC", 51, 3);
  assert.equal(e.onPrice(al, "ZEC", 49, 4).length, 1);
});

test("cooldown suppresses re-cross, then allows after expiry", () => {
  const e = new CrossingEngine(); const al = [A({ cooldownMin: 30 })];
  e.onPrice(al, "ZEC", 90, 0);
  assert.equal(e.onPrice(al, "ZEC", 101, 1 * M).length, 1);
  e.onPrice(al, "ZEC", 99, 2 * M);
  assert.equal(e.onPrice(al, "ZEC", 101, 10 * M).length, 0, "within cooldown");
  e.onPrice(al, "ZEC", 99, 40 * M);
  assert.equal(e.onPrice(al, "ZEC", 101, 41 * M).length, 1, "after cooldown");
});

test("disabled alerts and other symbols ignored; changed level resets state", () => {
  const e = new CrossingEngine();
  e.onPrice([A({ enabled: false })], "ZEC", 90, 0);
  assert.equal(e.onPrice([A({ enabled: false })], "ZEC", 110, 1).length, 0);
  assert.equal(e.onPrice([A()], "ETH", 110, 1).length, 0);
  const al = [A({ level: 200 })]; e.sync(al);
  e.onPrice(al, "ZEC", 150, 2);
  assert.equal(e.onPrice(al, "ZEC", 201, 3).length, 1);
});

test("validateAlerts fills defaults and rejects bad input", () => {
  const v = validateAlerts({ alerts: [{ id: "x", symbol: "eth", op: "below", level: 2000 }] });
  assert.deepEqual(v.alerts[0], { id: "x", symbol: "ETH", op: "below", level: 2000, cooldownMin: 30, oneShot: false, enabled: true });
  assert.throws(() => validateAlerts({}), /alerts/);
  assert.throws(() => validateAlerts({ alerts: [{ id: "x", symbol: "ETH", op: "sideways", level: 1 }] }), /op/);
  assert.throws(() => validateAlerts({ alerts: [{ id: "x", symbol: "ETH", op: "above", level: -1 }] }), /level/);
  assert.throws(() => validateAlerts({ alerts: [{ id: "x", symbol: "ETH", op: "above", level: 1 }, { id: "x", symbol: "BTC", op: "above", level: 1 }] }), /duplicate/);
  assert.throws(() => validateAlerts({ alerts: [{ id: "x", symbol: "ETH", op: "above", level: 1, cooldownMin: "5" }] }), /cooldown/);
});

test("saveAlerts is atomic and round-trips; refuses invalid data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-"));
  const f = path.join(dir, "alerts.json");
  saveAlerts({ alerts: [A()] }, f);
  assert.equal(loadAlerts(f).alerts[0].id, "a");
  assert.throws(() => saveAlerts({ alerts: [A({ op: "x" as any })] }, f));
  assert.equal(loadAlerts(f).alerts[0].op, "above", "file untouched after failed save");
  assert.deepEqual(fs.readdirSync(dir), ["alerts.json"], "no temp files left");
});

test("HF hysteresis: escalate, hold inside band, recover past band", () => {
  const m = new HfMonitor({ warn: 1.3, critical: 1.2, hysteresis: 0.02, repeatMin: 60 });
  assert.equal(m.update(1.45, 0), null);
  assert.equal(m.update(1.29, 1)?.level, "warn");
  assert.equal(m.update(1.31, 2), null, "inside hysteresis band stays warn");
  assert.equal(m.level, "warn");
  assert.equal(m.update(1.19, 3)?.level, "critical");
  assert.equal(m.update(1.21, 4), null, "stays critical inside band");
  const r = m.update(1.25, 5);
  assert.equal(r?.kind, "recover"); assert.equal(r?.level, "warn");
  assert.equal(m.update(1.33, 6)?.level, "ok");
});

test("HF repeat reminder honours repeatMin; first reading below warn alerts", () => {
  const m = new HfMonitor({ warn: 1.3, critical: 1.2, hysteresis: 0.02, repeatMin: 60 });
  assert.equal(m.update(1.25, 0)?.kind, "escalate");
  assert.equal(m.update(1.25, 30 * M), null);
  assert.equal(m.update(1.25, 61 * M)?.kind, "repeat");
});

test("decodeAccountData reads WAD health factor from word 2", () => {
  const w = (n: bigint) => n.toString(16).padStart(64, "0");
  const hex = "0x" + [0n, 8n * 10n ** 17n, 1444152000000000000n, 1n, 1n, 3n, 2n].map(w).join("");
  const d = decodeAccountData(hex);
  assert.equal(d.healthFactor, 1.444152);
  assert.equal(d.borrowCount, 2);
});

test("auth header template and payload shape", () => {
  assert.deepEqual(buildAuthHeader(undefined, "k1"), ["Authorization", "Bearer k1"]);
  assert.deepEqual(buildAuthHeader("X-Sender-Key: <key>", "k1"), ["X-Sender-Key", "k1"]);
  assert.equal(buildAuthHeader(undefined, undefined), null);
  const p = makePayload({ type: "price", symbol: "ZEC" }, new Date("2026-10-20T11:00:00Z"));
  assert.equal(p.time, "2026-10-20T11:00:00.000Z");
  assert.match(p.timeLondon, /12:00:00/);
});
