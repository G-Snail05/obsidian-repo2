import { config } from "../config.js";
import { fetchJson } from "../http.js";

export interface EthBalance {
  provider: "etherscan";
  chainId: number;
  address: string;
  balanceWei: string;
  balanceEth: number;
  asOf: string;
}

export interface GasOracle {
  provider: "etherscan";
  chainId: number;
  safeLowGwei: number;
  proposeGwei: number;
  fastGwei: number;
  suggestBaseFee?: number;
  asOf: string;
}

export interface TxReceiptSummary {
  provider: "etherscan";
  chainId: number;
  hash: string;
  status?: string;
  asOf: string;
}

type EtherscanResponse<T> = {
  status: string;
  message: string;
  result: T;
};

function requireKey(): string {
  const key = config.etherscan.apiKey;
  if (!key) {
    throw new Error("Etherscan: set ETHERSCAN_API_KEY in .env");
  }
  return key;
}

async function api<T>(
  params: Record<string, string>,
  chainId = config.etherscan.chainId,
): Promise<T> {
  const key = requireKey();
  const qs = new URLSearchParams({
    chainid: String(chainId),
    ...params,
    apikey: key,
  });
  const url = `${config.etherscan.baseUrl}?${qs.toString()}`;
  const data = await fetchJson<EtherscanResponse<T>>(url);
  if (data.status === "0" && data.message !== "No transactions found") {
    const detail =
      typeof data.result === "string" ? data.result : data.message;
    throw new Error(`Etherscan: ${detail}`);
  }
  return data.result;
}

export async function getEthBalance(
  address: string,
  chainId = config.etherscan.chainId,
): Promise<EthBalance> {
  const balanceWei = await api<string>(
    {
      module: "account",
      action: "balance",
      address,
      tag: "latest",
    },
    chainId,
  );
  const wei = BigInt(balanceWei);
  const balanceEth = Number(wei) / 1e18;
  return {
    provider: "etherscan",
    chainId,
    address,
    balanceWei,
    balanceEth,
    asOf: new Date().toISOString(),
  };
}

export async function getGasOracle(
  chainId = config.etherscan.chainId,
): Promise<GasOracle> {
  const result = await api<{
    SafeGasPrice: string;
    ProposeGasPrice: string;
    FastGasPrice: string;
    suggestBaseFee?: string;
  }>(
    {
      module: "gastracker",
      action: "gasoracle",
    },
    chainId,
  );
  return {
    provider: "etherscan",
    chainId,
    safeLowGwei: Number(result.SafeGasPrice),
    proposeGwei: Number(result.ProposeGasPrice),
    fastGwei: Number(result.FastGasPrice),
    suggestBaseFee: result.suggestBaseFee
      ? Number(result.suggestBaseFee)
      : undefined,
    asOf: new Date().toISOString(),
  };
}

export async function getTxStatus(
  hash: string,
  chainId = config.etherscan.chainId,
): Promise<TxReceiptSummary> {
  const result = await api<{
    status?: string;
    isError?: string;
  }>(
    {
      module: "transaction",
      action: "getstatus",
      txhash: hash,
    },
    chainId,
  );
  return {
    provider: "etherscan",
    chainId,
    hash,
    status: result.isError === "1" ? "error" : result.status ?? "ok",
    asOf: new Date().toISOString(),
  };
}
