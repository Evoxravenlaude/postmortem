# Graph Hacks submission: facts per field

Deadline: Oct 18, 2026, 11:59 PM IST (18:29 UTC). Register and submit at https://www.wemakedevs.org/hackathons/falkordb.

- **Project name:** Postmortem
- **Track:** 01, Agents That Act on Connected Data
- **Team:** solo, Rav3n
- **Repository:** https://github.com/Evoxravenlaude/postmortem
- **Live deployment:** https://postmortem-production-1cd2.up.railway.app
- **MCP endpoint:** `https://postmortem-production-1cd2.up.railway.app/mcp`
- **Demo video:** https://youtu.be/p02M6iydamc
- **Blog post:** https://x.com/Rav3nlaud3/status/2111791707888951348

## One-liner

Postmortem tells you why your money moved: it loads a wallet into a FalkorDB graph, finds outflows pulled through old approvals, shows the graph path behind every answer, and drafts the revokes.

## Description (draft, edit to taste)

Wallets get drained through approvals granted months earlier, and the owner rarely sees the link. Postmortem loads a wallet's transfers, transactions, approvals and balances into a FalkorDB graph, stamping each transfer with who signed it and which contract it called. An agent then walks the graph. It separates swaps and transfers the owner signed from funds pulled by someone else, and ties each pull to the approval that allowed it. It follows the money hop by hop, expanding the graph as it goes, and re-checks every approval on-chain to score what is still exposed. Then it acts: it drafts the exact revoke transactions and writes a postmortem report back into the graph. Every answer shows its Cypher and the path that proves it. The same nine tools are served over MCP.

## How FalkorDB is central

- The whole investigation is Cypher over one graph per chain. There is no other database.
- Multi-hop, time-ordered path queries follow funds (`all(i IN range(...) WHERE rs[i].ts <= rs[i+1].ts)`).
- `shortestPath` links any two addresses; `algo.pageRank` ranks counterparties.
- The agent writes its decisions back into the graph: risk scores on `APPROVED` edges, `(:Action)` revoke nodes, and `(:Report)` nodes.
- Read-only queries go through `GRAPH.RO_QUERY`.

## Built during the event

All code was written Oct 17–18, 2026. Commits are in the repo history.

## Known limitations

See the README. In short: signature-based permits are not seen until used, smart-contract wallets look pulled, history is paged, and USD values use today's prices.
