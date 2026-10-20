import fs from "node:fs";

export type PayloadType = "price" | "hf" | "heartbeat" | "watcher_error" | "paper";
export interface Payload {
  type: PayloadType;
  symbol?: string;
  price?: number;
  level?: number | string;
  op?: string;
  note?: string;
  source?: string;
  alertId?: string;
  time: string;
  timeLondon: string;
  [k: string]: unknown;
}

export function londonTime(d = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  }).format(d);
}

export function makePayload(p: Omit<Payload, "time" | "timeLondon">, d = new Date()): Payload {
  return { ...p, time: d.toISOString(), timeLondon: londonTime(d) } as Payload;
}

/** Parse WEBHOOK_KEY_HEADER like "Authorization: Bearer <key>" or "X-Sender-Key: <key>". */
export function buildAuthHeader(template: string | undefined, key: string | undefined): [string, string] | null {
  if (!key) return null;
  const t = template?.trim() || "Authorization: Bearer <key>";
  const i = t.indexOf(":");
  if (i <= 0) throw new Error(`WEBHOOK_KEY_HEADER must look like "Header-Name: value with <key>"`);
  const name = t.slice(0, i).trim();
  const value = t.slice(i + 1).trim();
  return [name, value.includes("<key>") ? value.replace("<key>", key) : value + key];
}

export interface NotifierOpts {
  url?: string;
  key?: string;
  keyHeader?: string;
  log: (msg: string) => void;
  retries?: number;
  baseDelayMs?: number;
  dryRunFile?: string;
}

export class Notifier {
  constructor(private o: NotifierOpts) {}
  get dryRun() {
    return !this.o.url;
  }
  async send(p: Payload): Promise<boolean> {
    const body = JSON.stringify(p);
    if (!this.o.url) {
      this.o.log(`[dry-run] would POST ${body}`);
      if (this.o.dryRunFile) fs.appendFileSync(this.o.dryRunFile, body + "\n");
      return true;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    const auth = buildAuthHeader(this.o.keyHeader, this.o.key);
    if (auth) headers[auth[0]] = auth[1];
    const retries = this.o.retries ?? 5;
    let delay = this.o.baseDelayMs ?? 2000;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(this.o.url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
        if (r.ok) {
          this.o.log(`webhook ok ${r.status} type=${p.type} ${p.alertId ?? ""}`);
          return true;
        }
        this.o.log(`webhook HTTP ${r.status} (attempt ${attempt + 1})`);
        if (r.status >= 400 && r.status < 500 && r.status !== 429) return false; // won't fix itself
      } catch (e) {
        this.o.log(`webhook error (attempt ${attempt + 1}): ${(e as Error).message}`);
      }
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, delay));
        delay = Math.min(delay * 2, 60_000);
      }
    }
    return false;
  }
}
