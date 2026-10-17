/**
 * A synthetic wallet history in Blockscout API v2 shapes, for tests only. Every address,
 * hash and amount here is made up. The story: the wallet swaps, sends ETH to a friend,
 * grants an unlimited USDC approval to an unverified contract, and later 900 USDC is pulled
 * through that approval by an attacker who forwards it to an exchange.
 */
export const W = "0x1111111111111111111111111111111111111111";
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const ROUTER = "0x2222222222222222222222222222222222222222";
export const POOL = "0x3333333333333333333333333333333333333333";
export const DRAINER = "0x4444444444444444444444444444444444444444";
export const ATTACKER = "0x5555555555555555555555555555555555555555";
export const EXCHANGE = "0x6666666666666666666666666666666666666666";
export const FRIEND = "0x7777777777777777777777777777777777777777";
export const MAX = (2n ** 256n - 1n).toString();

const at = (s: number) => new Date(Date.UTC(2026, 8, 1) + s * 1000).toISOString();
export const T = (s: number) => Math.floor((Date.UTC(2026, 8, 1) + s * 1000) / 1000);

const addr = (hash: string, extra: Record<string, unknown> = {}) => ({ hash, name: null, is_contract: false, is_verified: false, ens_domain_name: null, public_tags: [], ...extra });
const usdc = { address_hash: USDC, symbol: "USDC", name: "USD Coin", decimals: "6", type: "ERC-20", exchange_rate: "1.0" };
const weth = { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: "18", type: "ERC-20", exchange_rate: "3000" };

const router = addr(ROUTER, { name: "SwapRouter02", is_contract: true, is_verified: true });
const pool = addr(POOL, { name: "UniswapV3Pool", is_contract: true, is_verified: true });
const drainer = addr(DRAINER, { is_contract: true, is_verified: false });
const attacker = addr(ATTACKER);
const exchange = addr(EXCHANGE, { public_tags: [{ display_name: "Binance 14", label: "binance" }] });
const friend = addr(FRIEND);
const wallet = addr(W, { ens_domain_name: "victim.eth" });
const usdcContract = addr(USDC, { name: "FiatTokenProxy", is_contract: true, is_verified: true });

const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");

export const walletTxs = [
  {
    hash: h(1), timestamp: at(1000), from: wallet, to: usdcContract, value: "0", fee: { type: "actual", value: "300000000000000" }, status: "ok", method: "approve",
    decoded_input: { method_call: "approve(address spender, uint256 value)", method_id: "095ea7b3", parameters: [{ name: "spender", type: "address", value: DRAINER }, { name: "value", type: "uint256", value: MAX }] },
  },
  {
    hash: h(2), timestamp: at(2000), from: wallet, to: router, value: "0", fee: { type: "actual", value: "900000000000000" }, status: "ok", method: "exactInputSingle",
    decoded_input: { method_call: "exactInputSingle(...)", method_id: "414bf389", parameters: [] },
  },
  { hash: h(3), timestamp: at(3000), from: wallet, to: friend, value: "100000000000000000", fee: { type: "actual", value: "21000000000000" }, status: "ok", method: null, decoded_input: null },
  {
    hash: h(4), timestamp: at(4000), from: wallet, to: usdcContract, value: "0", fee: { type: "actual", value: "300000000000000" }, status: "ok", method: "approve",
    decoded_input: { method_call: "approve(address spender, uint256 value)", method_id: "095ea7b3", parameters: [{ name: "spender", type: "address", value: ROUTER }, { name: "value", type: "uint256", value: "500000000" }] },
  },
];

export const pullTx = { hash: h(9), timestamp: at(5000), from: attacker, to: drainer, value: "0", fee: { type: "actual", value: "500000000000000" }, status: "ok", method: "sweep", decoded_input: null };

export const walletTransfers = [
  { transaction_hash: h(2), log_index: 3, timestamp: at(2000), from: wallet, to: pool, token: usdc, total: { value: "100000000", decimals: "6" }, type: "token_transfer", method: "exactInputSingle" },
  { transaction_hash: h(2), log_index: 4, timestamp: at(2000), from: pool, to: wallet, token: weth, total: { value: "30000000000000000", decimals: "18" }, type: "token_transfer", method: "exactInputSingle" },
  { transaction_hash: h(9), log_index: 1, timestamp: at(5000), from: wallet, to: attacker, token: usdc, total: { value: "900000000", decimals: "6" }, type: "token_transfer", method: "sweep" },
  { transaction_hash: h(10), log_index: 0, timestamp: at(500), from: exchange, to: wallet, token: usdc, total: { value: "1050000000", decimals: "6" }, type: "token_transfer", method: "transfer" },
];

export const attackerTransfers = [
  { transaction_hash: h(11), log_index: 0, timestamp: at(6000), from: attacker, to: exchange, token: usdc, total: { value: "900000000", decimals: "6" }, type: "token_transfer", method: "transfer" },
];

export const balances = [
  { token: usdc, value: "50000000" },
  { token: weth, value: "30000000000000000" },
];

/** Routes Blockscout and RPC calls to the fixtures above. */
export const SPAM = "0x8888888888888888888888888888888888888888";
const spam = { address_hash: SPAM, symbol: "FREEMOON", name: "FreeMoon", decimals: "18", type: "ERC-20", exchange_rate: null };
/** The pattern seen on busy real wallets: an unpriced token "moved" by a stranger, and an old unlimited approval to a verified router. */
export const spamTransfer = { transaction_hash: h(20), log_index: 0, timestamp: at(7000), from: wallet, to: attacker, token: spam, total: { value: "5000000000000000000000", decimals: "18" }, type: "token_transfer", method: "airdrop" };
export const spamPullTx = { hash: h(20), timestamp: at(7000), from: attacker, to: router, value: "0", fee: { type: "actual", value: "1" }, status: "ok", method: "multicall", decoded_input: null };
export const spamApproveTx = {
  hash: h(21), timestamp: at(1500), from: wallet, to: addr(SPAM, { is_contract: true, is_verified: false }), value: "0", fee: { type: "actual", value: "1" }, status: "ok", method: "approve",
  decoded_input: { method_call: "approve(address spender, uint256 value)", method_id: "095ea7b3", parameters: [{ name: "spender", type: "address", value: ROUTER }, { name: "value", type: "uint256", value: MAX }] },
};

export function fakeFetch(opts: { drainerAllowance?: string; internalFails?: boolean; txPage2Fails?: boolean; withSpam?: boolean } = {}) {
  const calls: string[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const data: string = body.params[0].data;
      const pad = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
      if (data.startsWith("0xdd62ed3e")) {
        const spender = "0x" + data.slice(-40);
        if (spender === DRAINER) return json({ result: pad(BigInt(opts.drainerAllowance ?? MAX)) });
        if (spender === ROUTER) return json({ result: pad(body.params[0].to === SPAM ? BigInt(MAX) : 400000000n) });
        return json({ result: pad(0n) });
      }
      return json({ result: "0x" });
    }
    const u = new URL(url);
    const p = u.pathname;
    if (p.endsWith(`/addresses/${W}/token-transfers`)) return json({ items: opts.withSpam ? [...walletTransfers, spamTransfer] : walletTransfers, next_page_params: null });
    if (p.endsWith(`/addresses/${W}/transactions`)) {
      if (!opts.txPage2Fails) return json({ items: opts.withSpam ? [...walletTxs, spamApproveTx] : walletTxs, next_page_params: null });
      if (u.searchParams.has("block_number")) return new Response("timeout", { status: 524 });
      return json({ items: walletTxs.slice(1), next_page_params: { block_number: 1, index: 0 } });
    }
    if (p.endsWith(`/addresses/${W}/internal-transactions`)) return opts.internalFails ? new Response("timeout", { status: 524 }) : json({ items: [], next_page_params: null });
    if (p.endsWith(`/addresses/${W}/token-balances`)) return json(balances);
    if (p.endsWith(`/stats`)) return json({ coin_price: "3000.00" });
    if (p.endsWith(`/addresses/${W}`)) return json({ ...wallet, coin_balance: "1000000000000000000" });
    if (p.endsWith(`/transactions/${h(9)}`)) return json(pullTx);
    if (p.endsWith(`/transactions/${h(20)}`)) return json(spamPullTx);
    if (p.endsWith(`/addresses/${ATTACKER}/token-transfers`)) return json({ items: attackerTransfers, next_page_params: null });
    if (p.includes("/token-transfers")) return json({ items: [], next_page_params: null });
    return new Response("not found", { status: 404 });
  };
  return { fn, calls };
}
