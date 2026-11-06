// Live check for Walrus Memory + Tatum. Run on a machine with internet, with .env filled:
//   npx tsx --env-file=.env scripts/memory-check.ts
// Writes one incident memory, recalls it, prints the blob id and the Sui checkpoint. Nothing else.
import { NS, health, memoryMode, recall, remember } from "../src/memory/memwal.js";
import { suiCheckpoint, tatumEnabled } from "../src/sources/tatum.js";

const at = new Date().toISOString();
console.log("tatum key:", tatumEnabled() ? "set" : "missing");
console.log("sui checkpoint:", (await suiCheckpoint()) ?? "none (no key or gateway unreachable)");

const e = await remember(NS.incidents, { kind: "incident", chain: "ethereum", wallet: "0x0000000000000000000000000000000000000000", reasons: ["memory check from " + at.slice(0, 19)], at }, { idempotencyKey: "memory-check-" + at });
console.log("mode:", memoryMode());
console.log("blob id:", e.blob_id);
if (e.mode === "live") console.log("view:", "https://walruscan.com/mainnet/blob/" + e.blob_id);

const back = await recall(NS.incidents, "memory check", 5);
console.log("recall hits:", back.length, back[0] ? "first: " + back[0].text.split("\n")[0] : "");
console.log("health:", await health());
