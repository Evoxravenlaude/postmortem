# Tatum Total Recall: the form, field by field

Deadline: **Nov 10, 2026, 17:00 UTC**. Form: https://tatum.io/hackathon/total-recall (stay on the page, fill the form).
Everything below is a fact you can paste or a fact to put in your own words. Fields marked *yours* are written by you.

## 01 Contact

| Field | Value |
| --- | --- |
| Email | your email |
| Discord handle | yours |
| LinkedIn | yours (required) |
| Telegram ID | `@rav3nlaud` (optional) |
| How did you hear | pick one (Hackathon Listings fits) |
| First Web3 project? | No |

## 02 Accounts

| Field | Value | Where it came from |
| --- | --- | --- |
| Tatum ID | `6aee5dd00b2c2aba7e28bd4a` | dashboard.tatum.io → My Account → My Account Info |
| SUI address | `0x0b6565148c10606336718411ff2e049b696513e0825266c0e1c5a22963d07906` | Slush wallet |
| Account ID (SUI) | `0xaf8e05553a184d7a8922bc5beb6a38b2fb7c370f55b297f049efde45922ef4b6` | memory.walrus.xyz/dashboard |
| MEMWAL_AGENT_ID | `deb4d63d4b3d5708d01dfaeef53a38bf744cc82e55f6079e180dadf43e1704e0` | memory.walrus.xyz/dashboard → Delegate keys → Public key |

Public values only. The delegate *private* key and the Tatum API key never go in the form or the repo.

## 03 Project

- **GitHub repo:** `https://github.com/Evoxravenlaude/postmortem`
- **Live app:** `https://postmortem-production-1cd2.up.railway.app` (MCP at `/mcp`)
- **Demo video:** your new 2–3 min upload (shot list below). Not the Graph Hacks video.
- **Additional documentation:** `https://github.com/Evoxravenlaude/postmortem/blob/main/docs/TOTAL_RECALL.md` (this file). Also worth linking: `https://github.com/Evoxravenlaude/postmortem#memory-the-law-merchants-record-check` and the blog post once published.

### Project description: facts to write from (*yours*)

**The problem.** Wallets are drained through token approvals granted weeks earlier. Postmortem (built at Graph Hacks) explains one drained wallet at a time. It had no memory: a drainer it caught on wallet A was a stranger again on wallet B.

**What memory found, on mainnet, on its first day.** The July 2026 999,999 USDT approval-phishing drain split the victim's USDT 20/80 between two wallets. The 20% went to `0xf84c62572eEaFC90C0BCE3Fb6c85bCB573E68d93`, a drainer kit's fee wallet that took a cut from dozens of wallets between July and October. Each victim had approved a *different*, freshly deployed spender contract, and at least three different operator wallets signed the pulls (`0x6d8c…32b9`, `0xd643…6908`, `0x09cf…0c9d`). The spender changed every time. The fee wallet never did.

So Postmortem Remembers records three addresses per pull, each with a role: the **spender**, the **payout** wallet the money landed in, and the **operator** that signed. After four victims, the fee wallet's record reads "received pulled funds from 4 drained wallets", credibility 0/100, and every new victim's analysis opens with: *"the pulled funds went to 0xf84c…8d93, which has a record from N other drained wallets. Same drainer."* Drainers rotate contracts and signers. They do not rotate where the money goes.

**How Walrus Memory is used.**
- SDK `@mysten-incubation/memwal` 0.1.13, relayer `https://relayer.memory.walrus.xyz`, Walrus mainnet.
- Two namespaces: `incidents` (one per postmortem) and `counterparties` (one per address judged, with role and verdict).
- Write: `rememberAndWait(text, namespace, { idempotencyKey })`. The key is chain + wallet + address + role, so a re-run never double-counts. All writes for a report go out in parallel; the step waits at most 30 s and the rest land in the background.
- Read: `recall({ query, namespace, limit, maxDistance })`, then exact filtering on the parsed record. Each memory is one plain sentence (for semantic recall) plus the record as JSON (for exact scoring).
- The record is read before every verdict: `explain_outflows` checks the payout and operator wallets of each pull; `who_can_spend` checks every spender with a live approval.
- `check_record` folds one address's memories into a credibility score (100 clean, 0 drainer), one judgment per wallet and role, ignoring zero-value address-poisoning noise. It is an agent tool, an MCP tool, a REST route (`/api/record/:address`) and a form in the UI.
- Proof: every Memory panel row links to its blob on walruscan.com.

**How Tatum is used.**
- One `TATUM_API_KEY` routes the EVM reads (allowance, `isApprovedForAll`, Permit2) on Ethereum, Base, Arbitrum, Optimism, Polygon and Gnosis through Tatum gateways.
- The same gateway's `eth_blockNumber` stamps every memory with the block of the chain it judged, at write time ("judged at Ethereum block 26,361,xxx").

**Numbers to quote** (check the Memory panel header on the day you submit): 54+ memories on Walrus mainnet, 5+ drained wallets examined, 1 drainer fee wallet linked across 4 victims.

**Built during the event:** `src/memory/memwal.ts`, `src/sources/tatum.ts`, the `check_record` and `memory_ledger` tools, the record checks in `explain_outflows` and `who_can_spend`, the role-tagged writes in `write_postmortem`, address-poisoning classification, `/api/memory` and `/api/record/:address`, the Memory panel, `scripts/memory-check.ts`, `scripts/find-victims.ts`, `test/memory.test.ts` (8 tests). Postmortem itself is prior work from Graph Hacks (Oct 2026); say so plainly.

## 04 Feedback (*yours*; facts you can draw on)

**Walrus** (docs, tools, bugs, what to improve):
- Setup took minutes: account and delegate key from the dashboard, no Sui wallet or WAL needed to write through the relayer.
- `rememberAndWait` took roughly 10–20 s per write; 15 writes one after another took over 2 minutes. Parallel writes fixed it.
- `MemWalMock` reads the namespace from the second positional argument; passing it inside the options object is silently ignored, so mock tests passed for the wrong namespace until caught.
- There is no listing call for "everything in a namespace", so a local index of blob ids was needed for the inspector.
- No testnet relayer; the mock covers development, mainnet covers proof.

**Tatum AI Builder:** not used; say so in one line. Tatum was used for RPC gateways.

**One friction point (optional field):** Tatum's docs list the Sui JSON-RPC endpoint `https://sui-mainnet.gateway.tatum.io/` and `sui_getLatestCheckpointSequenceNumber`, but it returned `{"statusCode": 404, "message": "Not Found"}` with an API key that worked on the Ethereum gateway. The memory stamp was moved to the judged chain's block number instead.

**Social post links (optional, extra points):** your X post with the video and the fee-wallet finding.

## Demo video shot list (2–3 min)

1. **0:00** Header pills: `memory: Walrus mainnet · block stamp via Tatum`. "Postmortem explains why a wallet was drained. Now it remembers."
2. **0:10** Run victim 1 (`0x8c949361b49320c48a51f4b1c6f9f83862530f89`). Show the pull path, then `write_postmortem` with its memory writes.
3. **0:45** Run victim 2 (`0x8cb3f86497ea81c7cefd501c1c16e5406bfe75a2`). Stop on `explain_outflows`: "the pulled funds went to 0xf84c…8d93, which has a record". Different spender contract, same payout wallet.
4. **1:20** The 08:43 clip: victim 3, a *different operator*, same fee wallet, credibility 0/100.
5. **1:45** Check record on `0xf84c62572eEaFC90C0BCE3Fb6c85bCB573E68d93`: 4 drained wallets. Click a blob → Walruscan.
6. **2:10** Close: "Drainers rotate contracts and signers. They can't rotate where the money goes. Postmortem remembers."

Cut any frame that shows `0.000 USDC` lines; those were address-poisoning noise, now filtered.

## Before you press Submit

- [ ] Latest patch pushed and Railway redeployed
- [ ] Check record on the fee wallet shows 4 wallets, 0/100
- [ ] Video uploaded (unlisted is fine) and linked
- [ ] Blog published and linked
- [ ] 18+ and terms box ticked
