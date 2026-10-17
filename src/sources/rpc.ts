import { pad32 } from "../util.js";
import type { FetchLike } from "./blockscout.js";

/** Minimal JSON-RPC reads for live allowance and balance checks. */
export class Rpc {
  private id = 1;
  constructor(private url: string, private fetchImpl: FetchLike = fetch) {}

  async call(to: string, data: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      if (!res.ok) return null;
      const j: any = await res.json();
      return typeof j.result === "string" ? j.result : null;
    } catch {
      return null;
    }
  }

  private async uint(to: string, data: string): Promise<string | null> {
    const r = await this.call(to, data);
    if (!r || r === "0x") return null;
    try {
      return BigInt(r).toString();
    } catch {
      return null;
    }
  }

  allowance(token: string, owner: string, spender: string) {
    return this.uint(token, "0xdd62ed3e" + pad32(owner.slice(2)) + pad32(spender.slice(2)));
  }

  /** Permit2 allowance(owner, token, spender) returns (amount, expiration, nonce); amount is the first word. */
  async permit2Allowance(owner: string, token: string, spender: string) {
    const r = await this.call(PERMIT2, "0x927da105" + pad32(owner.slice(2)) + pad32(token.slice(2)) + pad32(spender.slice(2)));
    if (!r || r.length < 66) return null;
    return BigInt("0x" + r.slice(2, 66)).toString();
  }

  async isApprovedForAll(token: string, owner: string, operator: string) {
    const r = await this.uint(token, "0xe985e9c5" + pad32(owner.slice(2)) + pad32(operator.slice(2)));
    return r == null ? null : r !== "0";
  }

  balanceOf(token: string, owner: string) {
    return this.uint(token, "0x70a08231" + pad32(owner.slice(2)));
  }
}

export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
