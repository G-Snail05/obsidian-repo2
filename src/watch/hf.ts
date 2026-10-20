export type HfLevel = "ok" | "warn" | "critical";
export interface HfThresholds {
  warn: number;
  critical: number;
  hysteresis: number; // must climb this far above a threshold to clear it
  repeatMin: number; // re-alert while in warn/critical at most this often
}
export interface HfEvent {
  level: HfLevel;
  prev: HfLevel;
  hf: number;
  kind: "escalate" | "recover" | "repeat";
}

const rank: Record<HfLevel, number> = { ok: 0, warn: 1, critical: 2 };

/** Hysteresis state machine for the health factor. */
export class HfMonitor {
  level: HfLevel = "ok";
  lastHf?: number;
  private lastAlertAt?: number;
  private started = false;
  constructor(public t: HfThresholds) {}

  classify(hf: number): HfLevel {
    const { warn, critical, hysteresis } = this.t;
    // escalate immediately below thresholds
    if (hf < critical) return "critical";
    if (this.level === "critical" && hf < critical + hysteresis) return "critical";
    if (hf < warn) return "warn";
    if (this.level !== "ok" && hf < warn + hysteresis) return "warn";
    return "ok";
  }

  update(hf: number, now = Date.now()): HfEvent | null {
    this.lastHf = hf;
    const prev = this.level;
    const next = this.classify(hf);
    this.level = next;
    const first = !this.started;
    this.started = true;
    if (rank[next] > rank[prev] || (first && next !== "ok")) {
      this.lastAlertAt = now;
      return { level: next, prev, hf, kind: "escalate" };
    }
    if (rank[next] < rank[prev]) {
      this.lastAlertAt = now;
      return { level: next, prev, hf, kind: "recover" };
    }
    if (next !== "ok" && this.lastAlertAt !== undefined && now - this.lastAlertAt >= this.t.repeatMin * 60_000) {
      this.lastAlertAt = now;
      return { level: next, prev, hf, kind: "repeat" };
    }
    return null;
  }
}

const SELECTOR = "0xbf92857c"; // getUserAccountData(address)
const WAD = 10n ** 18n;

export interface AccountData {
  healthFactor: number;
  avgCollateralFactor: number;
  activeCollateralCount: number;
  borrowCount: number;
  raw: bigint[];
}

export function decodeAccountData(hex: string): AccountData {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 64 * 7) throw new Error(`unexpected getUserAccountData result: ${hex.slice(0, 80)}`);
  const w = Array.from({ length: 7 }, (_, i) => BigInt("0x" + h.slice(i * 64, i * 64 + 64)));
  const toNum = (x: bigint) => Number(x / 10n ** 12n) / 1e6; // WAD -> number, 6dp
  return {
    healthFactor: w[2] > 10n ** 30n ? Infinity : toNum(w[2]),
    avgCollateralFactor: toNum(w[1]),
    activeCollateralCount: Number(w[5]),
    borrowCount: Number(w[6]),
    raw: w,
  };
}
void WAD;

export interface HfSource {
  spoke: string;
  user: string;
  rpcUrl?: string;
  etherscanKey?: string;
  etherscanBase?: string;
}

export async function fetchAccountData(src: HfSource, timeoutMs = 15_000): Promise<AccountData> {
  const data = SELECTOR + src.user.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const signal = AbortSignal.timeout(timeoutMs);
  let result: string;
  if (src.rpcUrl) {
    const r = await fetch(src.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: src.spoke, data }, "latest"] }),
      signal,
    });
    const j: any = await r.json();
    if (j.error) throw new Error(`rpc error: ${JSON.stringify(j.error)}`);
    result = j.result;
  } else {
    if (!src.etherscanKey) throw new Error("no RPC_URL and no ETHERSCAN_API_KEY for health factor");
    const base = src.etherscanBase || "https://api.etherscan.io/v2/api";
    const url = `${base}?chainid=1&module=proxy&action=eth_call&to=${src.spoke}&data=${data}&tag=latest&apikey=${src.etherscanKey}`;
    const j: any = await (await fetch(url, { signal })).json();
    if (j.error) throw new Error(`etherscan error: ${JSON.stringify(j.error)}`);
    result = j.result;
  }
  if (!result || result === "0x") throw new Error("empty eth_call result (revert?)");
  return decodeAccountData(result);
}
