/** A wallet, contract or any other account as Postmortem sees it. */
export interface Party {
  addr: string; // lowercase 0x address
  name?: string;
  isContract?: boolean;
  verified?: boolean;
  ens?: string;
  tags?: string[];
}

export interface TokenRef {
  addr: string; // lowercase token contract, or "native"
  symbol: string;
  name?: string;
  decimals: number;
  type: string; // ERC-20, ERC-721, ERC-1155, native
  priceUsd?: number; // current price from the explorer, not historical
}

export type TransferKind = "token" | "native" | "internal";

export interface Transfer {
  key: string; // unique per movement: tx:logIndex, tx:native, tx:internal:n
  tx: string;
  ts: number; // unix seconds
  from: Party;
  to: Party;
  token: TokenRef;
  raw: string; // integer amount in base units
  amount: number; // human units
  method?: string;
  kind: TransferKind;
}

export interface TxRec {
  hash: string;
  ts: number;
  from: Party;
  to?: Party;
  method?: string;
  status: "ok" | "error";
  valueRaw: string;
  feeRaw: string;
  params?: { name: string; type: string; value: unknown }[];
}

export type ApprovalKind = "erc20" | "all" | "permit2";

export interface Approval {
  owner: string;
  spender: Party;
  token: TokenRef;
  raw: string; // approved amount in base units ("1" for setApprovalForAll true, "0" for revoke)
  unlimited: boolean;
  ts: number;
  tx: string;
  kind: ApprovalKind;
}

export interface Holding {
  token: TokenRef;
  raw: string;
  amount: number;
}

/** What a tool shows as proof: the queries it ran and the graph paths behind its answer. */
export interface Evidence {
  cypher: string[];
  paths: PathView[];
}

export interface PathNode {
  id: string; // address or tx hash
  label: string; // Address, Token, Tx, Action, Report
  name?: string;
  props?: Record<string, unknown>;
}

export interface PathEdge {
  from: string;
  to: string;
  type: string;
  props?: Record<string, unknown>;
}

export interface PathView {
  title: string;
  nodes: PathNode[];
  edges: PathEdge[];
}

export interface ToolResult {
  summary: string;
  data: unknown;
  evidence: Evidence;
}
