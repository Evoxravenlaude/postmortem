# The agent that remembers who drained you

*Draft for Rav3n to rewrite in his own voice. Every claim below is true of the code in this repo; the framing is yours to change.*

---

Wallets get drained through approvals. You sign `approve(spender, unlimited)` for a mint in March; in September the spender's owner, or whoever bought their keys, calls `transferFrom` and your USDC is gone. The chain shows a transfer you never signed. Nothing on the chain tells you that the same spender did this to four hundred other wallets last month.

That was the hole in Postmortem, the wallet-forensics agent I built at Graph Hacks. It loads a wallet into a FalkorDB graph, finds the pulls, ties each to the approval that allowed it, follows the money, drafts the revokes. It was good at one wallet. It knew nothing about the last wallet. Every run started from zero, and a drainer that it had just caught was a stranger again a minute later.

## The Law Merchant

Medieval trade fairs solved the stranger problem without a police force. The merchant courts kept records. Before you dealt with someone from another town, you paid a small fee to check their record: had they defaulted, had they been judged, had they paid. Nobody could force a merchant to be honest. Everybody could see whether they had been.

Postmortem Remembers is that record, kept on Walrus.

## What it does now

Every time the agent writes a postmortem, it also writes memories:

- one **incident** memory: this wallet, this chain, these findings;
- one **counterparty** memory per spender it judged: verdict (`pulled`, `tagged`, `high`, `medium`, `low`), how much was pulled, from which wallet, in how many transactions.

And before it judges any spender, it recalls. `who_can_spend` calls `check_record` on every address that can still move the wallet's tokens. If the address has a record, the risk score goes up and the reasons say why: *seen in 2 prior postmortems across 2 wallets; pulled funds 2 times*. The warning arrives before this wallet has lost anything.

`check_record` folds everything memory holds about one address into a credibility score, 100 for a clean record down to 0 for a drainer. It is a tool for the agent, an MCP tool for Claude or Cursor, a REST route, and a text box in the UI.

## Why Walrus, and why Tatum

A database would have done the remembering. It would not have done the proving. Each memory is a Walrus blob with a public id. The claim "Postmortem judged this address a drainer on November 7" is checkable by anyone who opens the blob, and the memory outlives the server that wrote it. I keep a local ledger of blob ids as an index, nothing more.

Each memory is one plain sentence followed by the exact record as JSON. The sentence is what recall searches by meaning; the JSON is what scoring parses. Nothing in the score is approximate.

Tatum does two jobs. One key moves the agent's chain reads (allowance, `isApprovedForAll`, Permit2, on six chains) onto Tatum gateways instead of public nodes that rate-limit. And Tatum's Sui gateway gives me `sui_getLatestCheckpointSequenceNumber`, so every memory is stamped with the Sui checkpoint current at the moment it was written. A record is placed in time against the chain Walrus settles on.

## What I learned

- Memory text should be written for two readers. The embedding reads the sentence; the code reads the JSON. Trying to make one text serve both badly serves both.
- Idempotency keys matter more than they look. Re-running a wallet must not double-count its drainer. The report id is the key.
- Credibility needs a floor and a ceiling, and the penalties need to be lopsided. One pull should cost more than ten clean appearances can buy back.
- A mock that behaves like the real thing is what makes the tests and the local demo honest. The UI says which one is running.

## What is next

One instance's memory is one merchant court. The obvious next step is the fair itself: a shared namespace that many Postmortem instances write to, so a drainer caught anywhere is known everywhere. Walrus makes that a configuration change, not an architecture change.

The chain remembers transactions. Now the agent remembers judgments.

Code: github.com/Evoxravenlaude/postmortem · Live: `<Railway URL>`
