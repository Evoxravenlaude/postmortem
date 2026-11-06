# Tatum Total Recall submission: facts per field

Deadline: Nov 10, 2026, 17:00 UTC. Submit at https://tatum.io/hackathon/total-recall. Draft on the form on day one; final by Nov 9.

- **Project name:** Postmortem Remembers
- **Builder:** Rav3n, solo
- **Repository:** `https://github.com/Evoxravenlaude/postmortem`
- **Live app:** your Railway URL (same deploy as Postmortem, with `MEMWAL_*` and `TATUM_API_KEY` set)
- **MCP endpoint:** `<Railway URL>/mcp`
- **Blog post:** `docs/BLOG.md` published on your blog or dev.to; link it
- **Demo video:** 2 to 3 minutes; see the shot list below
- **Walrus proof:** paste 10+ blob ids from the Memory panel (each links to walruscan.com) and the Walrus account id

## One-liner

Postmortem Remembers gives a wallet-forensics agent long-term memory on Walrus: every postmortem it writes is remembered, and before it judges any spender it checks the spender's record across every wallet it has ever examined.

## Description (facts; write it in your words)

- Postmortem loads a wallet into a FalkorDB graph and finds funds pulled through old approvals; it drafts the revokes and writes a report.
- New in this build: the report and one record per spender are written to Walrus Memory through `@mysten-incubation/memwal` (`rememberAndWait`, idempotency key = report id). Two namespaces: `incidents`, `counterparties`.
- `who_can_spend` now recalls every spender's record before scoring it. A spender with a record of pulling funds gets +2 risk and the reason "has a record: seen in N prior postmortems across M wallets; pulled funds K times".
- `check_record` folds every memory about one address into a credibility score (100 clean to 0 drainer); it is a tool for the agent, an MCP tool for any client, a REST route (`/api/record/:address`) and a form in the UI.
- Tatum: `TATUM_API_KEY` routes the EVM reads (allowance, isApprovedForAll, Permit2) on six chains through Tatum gateways, and `sui_getLatestCheckpointSequenceNumber` on Tatum's Sui gateway stamps every memory with the checkpoint current at write time.
- Memory text is one plain sentence plus the exact record as JSON, so semantic recall and exact parsing both work.
- Without keys the SDK mock runs; the UI shows which mode is live.

## Why memory changes the product

Before: each postmortem started from zero. A drainer that emptied wallet A was a stranger again on wallet B.
After: the second wallet's analysis opens with the drainer's record. The memory is shared across every wallet one instance has seen, it is on Walrus rather than in a database that dies with the server, and the blob ids are public proof of when each judgment was made.

## How Walrus Memory is used (checklist for the form)

- SDK: `@mysten-incubation/memwal` 0.1.13, `MemWal.create({ key, accountId, serverUrl, namespace })`.
- Write: `rememberAndWait(text, namespace, { idempotencyKey })` per incident and per counterparty.
- Read: `recall({ query, namespace, limit, maxDistance })`, filtered to the exact address by the parsed JSON.
- Persistence: Walrus mainnet via the relayer; local `data/memory-ledger.json` is only an index of blob ids.
- Mainnet writes: run 10+ real postmortems on drained wallets before submitting (the ledger counts them; the header pill shows the count).

## Demo video shot list (2–3 min)

1. Header pills: `memory: Walrus mainnet · Sui stamp via Tatum`. (5 s)
2. Run a drained wallet. Steps appear; `write_postmortem` data shows `memory.incident` and `memory.counterparties` blob ids. (40 s)
3. Memory panel: the new rows, click one blob → Walruscan. (15 s)
4. Check record on the drainer → credibility, pulls, wallets. (15 s)
5. Run a second wallet the same drainer hit. `who_can_spend` reason line says "has a record" *before* any pull is found; risk is already high. (40 s)
6. Check record again → 2 wallets, credibility down. (10 s)
7. MCP client calling `check_record`. (15 s)
8. The line: the chain remembers transactions; now the agent remembers judgments.

## Built during the event

`src/memory/memwal.ts`, `src/sources/tatum.ts`, the two tools, the memory hooks in `who_can_spend` and `write_postmortem`, `/api/memory` and `/api/record/:address`, the Memory panel, `test/memory.test.ts` (5 tests), and this doc. Everything else is Postmortem as shipped for Graph Hacks (Oct 2026), which the rules allow as prior work when the memory layer is the new part; say so on the form.
