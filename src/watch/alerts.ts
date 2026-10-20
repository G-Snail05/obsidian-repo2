import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Op = "above" | "below";
export interface Alert {
  id: string;
  symbol: string;
  op: Op;
  level: number;
  note?: string;
  cooldownMin: number;
  oneShot: boolean;
  enabled: boolean;
}
export interface AlertsFile {
  alerts: Alert[];
}

export const DEFAULT_ALERTS_PATH =
  process.env.ALERTS_FILE?.trim() || path.resolve(process.cwd(), "alerts.json");

/** Validate raw JSON; throws with a readable message on the first problem. Fills defaults. */
export function validateAlerts(raw: unknown): AlertsFile {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).alerts)) {
    throw new Error('alerts file must be an object with an "alerts" array');
  }
  const seen = new Set<string>();
  const alerts = ((raw as any).alerts as unknown[]).map((a, i) => {
    const where = `alerts[${i}]`;
    if (!a || typeof a !== "object") throw new Error(`${where}: not an object`);
    const o = a as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) throw new Error(`${where}: id must be a non-empty string`);
    if (seen.has(o.id)) throw new Error(`${where}: duplicate id ${o.id}`);
    seen.add(o.id);
    if (typeof o.symbol !== "string" || !/^[A-Za-z0-9]{1,15}$/.test(o.symbol))
      throw new Error(`${where}: symbol must be alphanumeric`);
    if (o.op !== "above" && o.op !== "below") throw new Error(`${where}: op must be above|below`);
    if (typeof o.level !== "number" || !Number.isFinite(o.level) || o.level <= 0)
      throw new Error(`${where}: level must be a positive number`);
    if (o.note !== undefined && typeof o.note !== "string") throw new Error(`${where}: note must be a string`);
    const cooldownMin = o.cooldownMin === undefined ? 30 : o.cooldownMin;
    if (typeof cooldownMin !== "number" || !Number.isFinite(cooldownMin) || cooldownMin < 0)
      throw new Error(`${where}: cooldownMin must be a number >= 0`);
    for (const k of ["oneShot", "enabled"] as const)
      if (o[k] !== undefined && typeof o[k] !== "boolean") throw new Error(`${where}: ${k} must be boolean`);
    const out: Alert = {
      id: o.id,
      symbol: o.symbol.toUpperCase(),
      op: o.op,
      level: o.level,
      cooldownMin,
      oneShot: (o.oneShot as boolean | undefined) ?? false,
      enabled: (o.enabled as boolean | undefined) ?? true,
    };
    if (o.note) out.note = o.note as string;
    return out;
  });
  return { alerts };
}

export function loadAlerts(file = DEFAULT_ALERTS_PATH): AlertsFile {
  if (!fs.existsSync(file)) return { alerts: [] };
  return validateAlerts(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Atomic write: temp file in same dir, fsync, rename. */
export function saveAlerts(data: AlertsFile, file = DEFAULT_ALERTS_PATH): void {
  validateAlerts(data);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function newAlertId(a: Pick<Alert, "symbol" | "op" | "level">): string {
  return `${a.symbol.toLowerCase()}-${a.op}-${a.level}-${crypto.randomBytes(2).toString("hex")}`;
}

// ---------- crossing engine (pure) ----------

export interface AlertState {
  armed: boolean | undefined; // undefined until first price seen
  lastFiredAt?: number;
}
export interface Fire {
  alert: Alert;
  price: number;
}

function beyond(op: Op, price: number, level: number): boolean {
  return op === "above" ? price >= level : price <= level;
}

/**
 * Crossing semantics: an alert is armed while price is on the "not triggered" side.
 * It fires once when an armed alert's price moves beyond the level, then disarms until
 * price crosses back. If the very first price is already beyond, it starts disarmed
 * (no fire at startup). Cooldown suppresses a fire but still disarms, so a later
 * re-cross after the cooldown fires normally.
 */
export class CrossingEngine {
  private state = new Map<string, AlertState>();

  stateOf(id: string): AlertState | undefined {
    return this.state.get(id);
  }

  /** Drop state for alerts that no longer exist or whose definition changed. */
  sync(alerts: Alert[]): void {
    const key = (a: Alert) => `${a.id}|${a.symbol}|${a.op}|${a.level}`;
    const keep = new Set(alerts.map(key));
    for (const k of [...this.state.keys()]) if (!keep.has(k)) this.state.delete(k);
    this.keyOf = key;
  }
  private keyOf = (a: Alert) => `${a.id}|${a.symbol}|${a.op}|${a.level}`;

  onPrice(alerts: Alert[], symbol: string, price: number, now = Date.now()): Fire[] {
    const fires: Fire[] = [];
    for (const a of alerts) {
      if (!a.enabled || a.symbol !== symbol) continue;
      const k = this.keyOf(a);
      let s = this.state.get(k);
      const isBeyond = beyond(a.op, price, a.level);
      if (!s) {
        this.state.set(k, { armed: !isBeyond });
        continue;
      }
      if (!isBeyond) {
        s.armed = true;
        continue;
      }
      if (s.armed) {
        s.armed = false;
        const cdMs = a.cooldownMin * 60_000;
        if (s.lastFiredAt !== undefined && now - s.lastFiredAt < cdMs) continue;
        s.lastFiredAt = now;
        fires.push({ alert: a, price });
      }
    }
    return fires;
  }
}
