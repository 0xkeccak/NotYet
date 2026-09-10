# Notyet — Bazantic recipe

**Agentify:** Notyet's timelocked x402 pay capability, exposed as MCP tools so any agent can
pay for services *on a schedule it can't front-run* — a key that doesn't exist before its time.

## MCP server

```
npx tsx bazantic/mcp-server.ts        # stdio MCP server
```

Register it with Bazantic / any MCP client as `notyet`.

## Tools

| Tool | Input | Does |
|---|---|---|
| `notyet_status` | `topicId` | Lists the periods on a Notyet HCS topic and whether each is `locked` or `ready`. |
| `notyet_pay` | `topicId`, `issuer`, `index`, `serviceUrl?` | Verifies the schedule on the topic is signed by the trusted `issuer`, unlocks period `index` (returns **NOT_YET** if its drand round hasn't arrived), pays the x402 service, and returns the settlement. |

## Recipe: "pay a metered API within a timelocked budget"

1. `notyet_status(topicId)` → find a `ready` period.
2. `notyet_pay(topicId, issuer, index)` →
   - refuses if the schedule isn't signed by `issuer` (trust),
   - refuses with `NOT_YET` if the period's key doesn't exist yet (time),
   - otherwise settles a real x402 payment on Hedera and returns the data + HashScan link.

The safety property travels with the capability: a compromised caller can only ever spend
the period whose key currently exists — never the whole schedule.

## Why this is a good agent primitive

Most "let an agent pay" recipes hand over a standing key. This one hands over a **schedule of
keys that unlock themselves on time** — so agent-to-agent payments get a blast-radius bound of
one period, for free.
