export const ZERO = "0x0000000000000000000000000000000000000000";

export function lc(a: string | undefined | null): string {
  return (a ?? "").toLowerCase();
}

export function isAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Integer base units to a float in human units without overflowing on 18-decimal amounts. */
export function toUnits(raw: string | bigint, decimals: number): number {
  let v: bigint;
  try {
    v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  } catch {
    return 0;
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const d = BigInt(Math.max(0, decimals));
  const base = 10n ** d;
  const whole = v / base;
  const frac = v % base;
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, "0").slice(0, 12) : "0";
  const n = Number(`${whole.toString()}.${fracStr}`);
  return neg ? -n : n;
}

/** Approvals at or above 2^128 are treated as unlimited (MAX_UINT256, uint160 Permit2 max, and friends). */
export function isUnlimited(raw: string): boolean {
  try {
    return BigInt(raw) >= 2n ** 128n;
  } catch {
    return false;
  }
}

export function tsOf(iso: string | undefined | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

export function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toPrecision(4);
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

export function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function pad32(hexNo0x: string): string {
  return hexNo0x.toLowerCase().padStart(64, "0");
}
