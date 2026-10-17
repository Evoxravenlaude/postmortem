# Demo video plan (about 2 minutes)

The judges want to see the graph shape what the agent does, and the path behind each answer. Show that, in this order.

## Pick the wallet before recording

Use a real wallet with a pull through an approval. One public case: on July 8, 2026 a trader lost 999,999 USDT on Ethereum after approving a phishing contract ([Cointelegraph](https://cointelegraph.com/news/trader-loses-1m-after-signing-phishing-token-approval)). Open the transaction it links on Blockscout (`https://eth.blockscout.com/tx/0x6e882fd802e96c51521869e9f433fec00aac5403d39356820d14e8a3f2e6ffb9`). The address the USDT moved **from** is the victim. Run it once off camera so the graph is warm, and check the run shows a "pulled by approval" step. If it does not, use your own wallet if it has old approvals.

## Shots

| Time | Screen | Say |
| --- | --- | --- |
| 0:00–0:10 | Title page | "Money left this wallet and the owner never signed for it. Postmortem finds out why." |
| 0:10–0:25 | Paste the address, click **Run postmortem** | "It loads the wallet into a FalkorDB graph: transfers, transactions, approvals, balances. Each transfer is stamped with who signed it." |
| 0:25–0:55 | Click the `explain_outflows` step, Graph tab | "Each outflow is classified by walking the graph. This one was signed by someone else, and the graph links it to an unlimited approval granted earlier. That approval edge is the proof." Hover the red and amber edges. |
| 0:55–1:05 | Cypher tab on the same step | "Every answer shows the Cypher that produced it." |
| 1:05–1:20 | `trace_funds` step | "Because money was pulled, the agent decides to follow it. It expands the graph hop by hop and shows where the funds came to rest." |
| 1:20–1:35 | `who_can_spend`, then **Drafted fixes** | "It re-checks every approval on-chain, scores the risk, and drafts the revoke transactions. Nothing is signed for you." |
| 1:35–1:50 | Postmortem report | "The report is written back into the graph as a node, next to the planned fixes." |
| 1:50–2:00 | Ask the graph (if an LLM key is set), or the MCP line | "Ask it anything. The same nine graph tools are served over MCP for any agent." |

Record at 1080p. Keep the browser zoom at 110% so the edge labels are readable.
