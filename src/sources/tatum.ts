// Tatum: one API key for RPC on every chain Postmortem reads.
// Set TATUM_API_KEY and the EVM reads (allowance, isApprovedForAll, Permit2) go through Tatum's
// gateways instead of public nodes, and blockStamp() stamps every memory with the block number of
// the chain it is about, read through the same gateway at write time. A record then says not just
// "judged on Nov 7" but "judged at Ethereum block 26,360,537": a point anyone can check on-chain.
const KEY = () => process.env.TATUM_API_KEY;

const EVM: Record<string, string> = {
  ethereum: "https://ethereum-mainnet.gateway.tatum.io/",
  base: "https://base-mainnet.gateway.tatum.io/",
  arbitrum: "https://arbitrum-one-mainnet.gateway.tatum.io/",
  optimism: "https://optimism-mainnet.gateway.tatum.io/",
  polygon: "https://polygon-mainnet.gateway.tatum.io/",
  gnosis: "https://gnosis-mainnet.gateway.tatum.io/",
};

export function tatumEnabled() {
  return !!KEY();
}
export function tatumRpc(chainKey: string): string | null {
  return KEY() ? EVM[chainKey] ?? null : null;
}
export function tatumHeaders(): Record<string, string> {
  return KEY() ? { "x-api-key": KEY()! } : {};
}

const cache = new Map<string, { v: number; t: number }>();
/** Latest block of `chainKey` via its Tatum gateway; null without a key, for an unknown chain, or on failure. Cached 10 s. */
export async function blockStamp(chainKey: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const url = tatumRpc(chainKey);
  if (!url) return null;
  const hit = cache.get(chainKey);
  if (hit && Date.now() - hit.t < 10_000) return hit.v;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...tatumHeaders() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const v = typeof j.result === "string" ? parseInt(j.result, 16) : NaN;
    if (!Number.isFinite(v)) return null;
    cache.set(chainKey, { v, t: Date.now() });
    return v;
  } catch {
    return null;
  }
}
