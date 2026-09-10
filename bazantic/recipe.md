# NotYet — Bazantic recipes

Two eligible tracks from one recipe set:

- **Agentify a new API** — the **drand** timelock beacon and **NotYet** itself are wrapped as
  agent-callable gateways (`bazantic/gateways/*.json`) + the NotYet MCP server.
- **Best recipe with sponsor APIs** — the flow below chains **three** APIs: drand (the clock),
  NotYet (the timelocked pay capability), and the **Hedera Mirror Node** (independent
  settlement confirmation). More than one sponsor/listed API in a single flow.

## MCP server

```
npx tsx bazantic/mcp-server.ts        # stdio MCP server
```

Register it with Bazantic / any MCP client as `notyet`. It's also publishable as an npm
package so *any* agent can "ask before spending" with a one-period blast radius.

## Tools

| Tool | Input | Does |
|---|---|---|
| `notyet_status` | `topicId` | Lists the periods on a NotYet HCS topic and whether each is `locked` or `ready`. |
| `notyet_pay` | `topicId`, `issuer`, `index`, `serviceUrl?` | Verifies the schedule on the topic is signed by the trusted `issuer`, unlocks period `index` (returns **NOT_YET** if its drand round hasn't arrived), pays the x402 service, returns the settlement. |

## Gateways (agentified APIs)

| Gateway | File | Base | Why it's in the flow |
|---|---|---|---|
| drand quicknet | `gateways/drand.json` | `https://api.drand.sh` | The public clock: has round R been published yet? This is what makes "not yet" true. |
| Hedera Mirror Node | `gateways/hedera-mirror.json` | `https://testnet.mirrornode.hedera.com` | Independent confirmation that the settlement actually landed (and, for the vault, that a scheduled/withdrawn transfer executed). |

Both are keyless public APIs — no secrets to agentify.

## Recipe: "pay a metered API within a timelocked budget, and prove it settled"

1. **drand** `GET /v2/beacons/quicknet/info` → read genesis + period; compute the current round.
2. `notyet_status(topicId)` → find a `ready` period (its round has passed).
3. `notyet_pay(topicId, issuer, index)` →
   - refuses unless the schedule is signed by `issuer` (**trust**),
   - refuses with **NOT_YET** if the period's key doesn't exist yet (**time**),
   - otherwise settles a real x402 payment on Hedera and returns the data + a HashScan link.
4. **Hedera Mirror Node** `GET /api/v1/transactions/{id}` (or `/schedules/{id}`) → confirm the
   settlement/execution independently, from a source the paying agent doesn't control.

If step 3 returns NOT_YET, the recipe's correct behavior is to **stop and retry on the
period's round** — never to look for another key. That's the whole point, and it's stated in
the tool description so an agent handles it without special-casing.

## Reusability (the judging criterion)

The recipe reads like a skill, not a one-off script:

- **When to call:** an agent needs to pay for a service but must not be able to spend beyond
  the current period's budget.
- **What it needs:** a NotYet `topicId` + the `issuer` address to trust (from the owner), and
  the service URL to pay.
- **What to do with `NOT_YET`:** back off to the period's unlock time; do not seek another key.
- **What you get:** the paid resource, a settlement id, and an independent mirror-node
  confirmation — a complete, auditable "spent within authority" record.

Any agent that can speak MCP inherits the safety property for free: a compromised caller can
only ever spend the one period whose key currently exists — never the whole schedule.
