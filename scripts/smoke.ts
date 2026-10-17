/**
 * Live connectivity check, read-only. Run it once after deploying, or locally:
 *   npm run smoke -- ethereum 0xYourWallet
 * It calls Blockscout, the chain RPC and FalkorDB and prints what came back, so a
 * wrong URL, a rate limit or a changed response shape shows up before a demo does.
 */
import { chainOf } from "../src/chains.js";
import { db } from "../src/graph/db.js";
import { Blockscout } from "../src/sources/blockscout.js";
import { Rpc } from "../src/sources/rpc.js";
import { isAddress } from "../src/util.js";

const [chainKey = "ethereum", addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] = process.argv.slice(2);
if (!isAddress(addr)) throw new Error(`Not a 0x address: ${addr}`);
const chain = chainOf(chainKey);
const bs = new Blockscout(chain.blockscout, chain.native);
const rpc = new Rpc(chain.rpc);
let failures = 0;
let reachable = false;
const ok = (label: string, good: boolean, detail: string) => {
  if (!good) failures++;
  console.log(`${good ? "PASS" : "FAIL"}  ${label.padEnd(26)} ${detail}`);
};

console.log(`Checking ${chain.name} for ${addr}\n  Blockscout ${chain.blockscout}\n  RPC        ${chain.rpc}\n`);

try {
  const { transfers } = await bs.tokenTransfers(addr.toLowerCase(), 1);
  const t = transfers[0];
  reachable = true;
  ok("token transfers", true, `${transfers.length} on page 1${t ? `, first: ${t.amount} ${t.token.symbol} (token ${t.token.addr.slice(0, 10)}…)` : ""}`);
  if (t) ok("token address field", t.token.addr.startsWith("0x"), t.token.addr);
} catch (e: any) {
  ok("token transfers", false, String(e?.message ?? e));
}
try {
  const { txs } = await bs.transactions(addr.toLowerCase(), 1);
  const decoded = txs.filter((x) => x.params?.length).length;
  ok("transactions", true, `${txs.length} on page 1, ${decoded} with decoded inputs`);
  const approves = txs.filter((x) => /approve/i.test(x.method ?? "")).length;
  ok("approve calls visible", true, `${approves} on page 1`);
} catch (e: any) {
  ok("transactions", false, String(e?.message ?? e));
}
const price = await bs.coinPrice();
ok("coin price", price !== undefined, String(price ?? "missing"));
const holdings = await bs.tokenBalances(addr.toLowerCase());
ok("token balances", reachable, reachable ? `${holdings.length} ERC-20 balances` : "skipped: Blockscout unreachable");

const usdc: Record<string, string> = {
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  arbitrum: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  optimism: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  polygon: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
};
if (usdc[chain.key]) {
  const bal = await rpc.balanceOf(usdc[chain.key], addr.toLowerCase());
  ok("RPC eth_call", bal !== null, bal === null ? "no answer" : `USDC balanceOf = ${bal}`);
}

try {
  await (await db()).list();
  ok("FalkorDB", true, process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379");
} catch (e: any) {
  ok("FalkorDB", false, String(e?.message ?? e));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
