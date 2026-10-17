export interface Chain {
  key: string;
  id: number;
  name: string;
  native: string;
  blockscout: string; // per-instance API base, ends with /api/v2
  rpc: string;
  explorer: string; // human explorer base
}

const env = (k: string) => process.env[k];

/** Blockscout instances and public RPCs. Each can be overridden with BLOCKSCOUT_<KEY> / RPC_<KEY>. */
const BASE: Chain[] = [
  { key: "ethereum", id: 1, name: "Ethereum", native: "ETH", blockscout: "https://eth.blockscout.com/api/v2", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://eth.blockscout.com" },
  { key: "base", id: 8453, name: "Base", native: "ETH", blockscout: "https://base.blockscout.com/api/v2", rpc: "https://base-rpc.publicnode.com", explorer: "https://base.blockscout.com" },
  { key: "arbitrum", id: 42161, name: "Arbitrum One", native: "ETH", blockscout: "https://arbitrum.blockscout.com/api/v2", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbitrum.blockscout.com" },
  { key: "optimism", id: 10, name: "OP Mainnet", native: "ETH", blockscout: "https://optimism.blockscout.com/api/v2", rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimism.blockscout.com" },
  { key: "polygon", id: 137, name: "Polygon", native: "POL", blockscout: "https://polygon.blockscout.com/api/v2", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygon.blockscout.com" },
  { key: "gnosis", id: 100, name: "Gnosis", native: "xDAI", blockscout: "https://gnosis.blockscout.com/api/v2", rpc: "https://gnosis-rpc.publicnode.com", explorer: "https://gnosis.blockscout.com" },
];

export function chains(): Chain[] {
  return BASE.map((c) => ({
    ...c,
    blockscout: env(`BLOCKSCOUT_${c.key.toUpperCase()}`) ?? c.blockscout,
    rpc: env(`RPC_${c.key.toUpperCase()}`) ?? c.rpc,
  }));
}

export function chainOf(key: string): Chain {
  const c = chains().find((x) => x.key === key.toLowerCase() || String(x.id) === key);
  if (!c) throw new Error(`Unknown chain "${key}". Use one of: ${BASE.map((b) => b.key).join(", ")}`);
  return c;
}
