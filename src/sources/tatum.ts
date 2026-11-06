// Tatum: one API key for RPC on every chain Postmortem reads, plus Sui for the memory stamp.
// Set TATUM_API_KEY and the EVM reads (allowance, isApprovedForAll, Permit2) go through Tatum's
// gateways instead of public nodes; suiCheckpoint() stamps every memory with the Sui checkpoint
// current at write time, so a record can be placed in time against the chain Walrus settles on.
const KEY = () => process.env.TATUM_API_KEY;

const EVM: Record<string, string> = {
  ethereum: "https://ethereum-mainnet.gateway.tatum.io/",
  base: "https://base-mainnet.gateway.tatum.io/",
  arbitrum: "https://arbitrum-one-mainnet.gateway.tatum.io/",
  optimism: "https://optimism-mainnet.gateway.tatum.io/",
  polygon: "https://polygon-mainnet.gateway.tatum.io/",
  gnosis: "https://gnosis-mainnet.gateway.tatum.io/",
};
const SUI = "https://sui-mainnet.gateway.tatum.io/";

export function tatumEnabled() {
  return !!KEY();
}
export function tatumRpc(chainKey: string): string | null {
  return KEY() ? EVM[chainKey] ?? null : null;
}
export function tatumHeaders(): Record<string, string> {
  return KEY() ? { "x-api-key": KEY()! } : {};
}

let lastCheckpoint: { v: string; t: number } | null = null;
/** Latest Sui checkpoint via Tatum's Sui RPC; null without a key or on failure. Cached 20 s. */
export async function suiCheckpoint(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!KEY()) return null;
  if (lastCheckpoint && Date.now() - lastCheckpoint.t < 20_000) return lastCheckpoint.v;
  try {
    const res = await fetchImpl(SUI, {
      method: "POST",
      headers: { "content-type": "application/json", ...tatumHeaders() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sui_getLatestCheckpointSequenceNumber", params: [] }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const v = typeof j.result === "string" ? j.result : null;
    if (v) lastCheckpoint = { v, t: Date.now() };
    return v;
  } catch {
    return null;
  }
}
