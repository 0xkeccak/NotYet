# NotYet — Bazantic

Two eligible surfaces from one capability:

- **Agentify a new API** — NotYet is wrapped as an agent-callable **gateway** on Bazantic,
  auto-generated from `web/public/openapi.json`. Any agent can call it over the hosted MCP
  endpoint with zero setup.
- **Recipe** — a published, reusable Bazantic Recipe that chains the gateway's tools into one
  "adopt time-gated spend authority" flow.

## Published Recipe

**Scheduled Data Feed Payment on Hedera** ·
`bazantic.com/.../recipes/scheduled-data-feed-payment-on-hedera` (published).

Issue a timelocked spend schedule for a data feed on NotYet, find the period that is ready to
unlock, unlock it, and settle the x402 payment on Hedera — returning the price data + a
settlement link. Only the currently-unlocked period can be spent, so a compromised caller's
blast radius is one period.

**Non-custodial by construction.** The Recipe takes **no secrets** — NotYet holds all operator
config server-side. Inputs are only:

| Input | Req? | Default | Meaning |
|---|---|---|---|
| `count` | optional | 3 | number of periods to schedule (1–5) |
| `periodSec` | optional | 15 | seconds between period unlocks (8–120) |
| `index` | required | — | the period index to unlock and pay |

**Tools it calls** (the keyless gateway tools, generated from the OpenAPI spec):

| Tool | Does |
|---|---|
| `issueSchedule` | Create a schedule of `count` periods; each period's spend key is committed on-chain, then tlock-encrypted to a future round. |
| `getStatus` | List the schedule's periods and whether each is `locked` / `ready` / `paid`. |
| `unlockAndPay` | Unlock period `index` (returns **NOT_YET** before its drand round), withdraw from the on-chain PeriodVault, settle the x402 payment. |
| `getPrice` | The x402-gated service being paid (402 challenge until settled). |

If `unlockAndPay` returns `notYet:true`, the correct behavior is to **wait for the period's
round and retry** — never to look for another key. That property is stated in the tool
description so an agent handles it without special-casing.

## Local MCP server (the SDK surface, adoptable in one line)

```
claude mcp add notyet -- npx tsx bazantic/mcp-server.ts     # stdio MCP server
```

Four SDK-like tools — three read-only and keyless, one guarded action:

| Tool | Input | Does |
|---|---|---|
| `notyet_explain` | — | Self-documenting onboarding: what NotYet is + how to integrate. |
| `notyet_status` | `topicId` | Lists a schedule's periods and whether each is `locked` or `ready`. |
| `notyet_verify` | `topicId`, `issuer` | Confirms the schedule is signed by the trusted issuer (trust anchor). |
| `notyet_spend` | `topicId`, `issuer`, `index`, `serviceUrl?` | Unlocks (NOT_YET if early), withdraws from the PeriodVault, settles x402. The only tool that moves funds. |

Any agent that can speak MCP inherits the safety property for free: a compromised caller can
only ever spend the one period whose key currently exists — never the whole schedule.

## Gateways (agentified keyless APIs, used by the SDK/full demo)

| Gateway | File | Base | Role |
|---|---|---|---|
| drand quicknet | `gateways/drand.json` | `https://api.drand.sh` | The public clock: has round R been published yet? This is what makes "not yet" true. |
| Hedera Mirror Node | `gateways/hedera-mirror.json` | `https://testnet.mirrornode.hedera.com` | Independent confirmation that a settlement actually landed, from a source the paying agent doesn't control. |

Both are keyless public APIs — no secrets to agentify.
