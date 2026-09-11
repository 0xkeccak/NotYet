# Notyet ⏳

**Scheduled agent spend authority where the key doesn't exist until its time.**

> Tuesday's key does not exist until Tuesday.

Built for **ETHOnline 2026** · Hedera · Ledger · Bazantic. Everything below runs **live on
testnets** — no mocks in the critical path.

---

## The problem

Autonomous agents need to spend on a schedule — daily budgets, per-shift API credits,
windowed signing rights. Every option today is broken:

- **Hand the agent everything up front** → a hacked or prompt-injected agent burns the
  whole budget at once.
- **A server releases keys just-in-time (cron / secrets manager)** → that server holds
  *every future key*. It's the honeypot, the single point of failure, the coercion target.

Session keys solve *expiry* — an agent's authority can end. **Nothing solves *start*:**
an agent's authority always exists the moment it's issued.

## The idea

**Timelock encryption (tlock).** Each period's spend key is encrypted to a future round
of the [drand](https://drand.love) beacon — a threshold network publishing a BLS
signature every 3s. That signature *is* the decryption key, and it does not exist until
the round happens. Nobody can decrypt early — not the agent, not the owner, not drand.

The owner pre-issues the whole schedule, hands the agent every *locked* key now, and
walks away. Each key unlocks itself on time. Stop issuing → the agent's future never
arrives. A kill switch with no kill message. And a hacked agent can only ever lose **one
period's** balance — the rest of the keys still don't exist.

## How the pieces fit

| Layer | Role | Proven by |
|---|---|---|
| **drand / tlock** | Encrypts each spend key to a future round — the lock itself | `npm run gate` (decrypt throws `NOT_YET`, then succeeds) |
| **Ledger** (Device Management Kit) | Issuer key signs the schedule with an on-device confirmation, via the Ledger DMK (Agent Stack) on Speculos | `scripts/test-ledger.ts` |
| **Hedera** | Root of trust + money + audit: the ciphertexts and encrypted receipts live on an HCS topic, and the **`PeriodVault`** contract holds the treasury and enforces each period's budget + `[start,end]` window + per-tx ceiling on-chain (`withdraw` reverts otherwise); x402 settled via Blocky402 | `scripts/test-vault.ts` (gate 5/5), `scripts/day1-gate.ts` |
| **Bazantic / MCP** | The whole capability exposed as MCP tools so other agents pay through Notyet — A2A payments that inherit the one-period blast radius | `bazantic/recipe.md` |

One chain, no bridge: Hedera holds the money, the audit log, *and* the signed rules the
agent verifies. The trust anchor is simply the issuer address the agent is told to trust.
(An optional ENS identity layer — human-readable name + ENSIP-26 agent records — lives on
the [`ens`](https://github.com/0xkeccak/NotYet/tree/ens) branch.)

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the two-key model, trust boundaries, and
the issue / spend / audit flows.

## What's live

- **Root of trust (Hedera HCS):** the Ledger-signed schedule is posted to an HCS topic as
  a `notyet:schedule` message; the agent reads it back and verifies the signature against
  the trusted issuer.
- **Ledger issuer (Device Management Kit on Speculos):** address `0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D`.
- **Bazantic / MCP:** `bazantic/mcp-server.ts` exposes `notyet_status` + `notyet_pay` so
  any agent can pay through Notyet (`npm run mcp`).
- **Hedera:** period accounts funded per-period; x402 settled through the Blocky402
  testnet facilitator (`api.testnet.blocky402.com`, keyless), the facilitator sponsors
  the fee. Example settlement:
  `https://hashscan.io/testnet/transaction/0.0.7162784@1788970917.201111289`

## Quickstart

```bash
npm install
cp .env.example .env          # fill in the values (see below)

# 1. Ledger emulator (no hardware needed — Ledger says Speculos qualifies in full)
bash scripts/speculos-up.sh   # boots the Ethereum app in Speculos on :5111

# 2. The x402-gated service the agent pays
npx tsx service/server.ts

# 3. The whole story, end to end (new terminal)
npx tsx scripts/full-demo.ts
#   ISSUER: Ledger (DMK) signs -> Hedera period accounts + HCS -> publish signed schedule to HCS
#   AGENT : resolve+verify from HCS -> NOT_YET on a future period -> unlock -> x402 pay
#   AUDIT : one period's view key decrypts only that period

# Or the clickable dashboard:
npx tsx web/server.ts         # http://localhost:4040

# Everything in one process (the hosted entry — landing + demo + x402 service):
npm start                     # x402 service on :4021, dashboard/landing on $PORT (4040)
```

The landing page (`web/public/index.html`) is a warm, editorial single-page site — a
plain-English explainer, the 4-pillar model, real-world incident cards, and the live
demo (issue → `NOT_YET` → unlock → x402 settle → audit) all wired to the running SDK.

### Hosting

`npm start` is a single process (`start.ts`) that Railway can run as-is. Deploy:

```bash
bash scripts/deploy.sh        # railway up (retries through the free-tier peak window),
                              # then generates a public domain and prints the URL
```

> **Live:** **https://notyet.up.railway.app** — the landing page and the full
> live demo (issue → `NOT_YET` → unlock → x402 settle → audit), running against Hedera
> testnet. (Railway free tier pins builds to `sfo`, closed during PT peak hours 8am–8pm;
> `scripts/deploy.sh` waits out that window.)

### The x402-gated service is live and callable

`GET https://notyet.up.railway.app/price` is a real x402-gated endpoint, settled through
the Blocky402 facilitator on Hedera testnet — hit it directly:

```bash
curl -i https://notyet.up.railway.app/price
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 x402 v2 challenge>
#   scheme "exact" · network "hedera:testnet" · payTo 0.0.10436969
#   · feePayer 0.0.7162784 (Blocky402 sponsors the fee)
# Pay with any x402 client → 200 + the price feed; settlement lands on HashScan.

curl -s https://notyet.up.railway.app/health   # { ok, network, facilitator, payTo }
```

The Notyet SDK's `payX402()` is one such client; the dashboard's "Unlock & pay" drives it.

Gate checks (the load-bearing primitives, verified against live services):

```bash
npm run gate                  # tlock roundtrip + decrypted-key Hedera settlement
npx tsx scripts/test-core.ts  # 17 offline checks (schedule, sign/verify, scoped receipts)
```

### .env

`HEDERA_PAYER_ID` / `HEDERA_PAYER_KEY` (ECDSA, from portal.hedera.com faucet) and
`HEDERA_MERCHANT_ID`. Secrets stay in `.env` (gitignored) — never committed. (The optional
ENS identity layer on the `ens` branch also uses `SEPOLIA_RPC_URL`, `ENS_OWNER_KEY`, `ENS_NAME`.)

## The three tracks — each load-bearing

- **Hedera — AI & Agentic Payments.** A live, callable x402 service (`/price`) settled via
  Blocky402; the **`PeriodVault`** contract that enforces each period's budget + window +
  per-tx ceiling on-chain (one contract, not N wallets); and an HCS topic carrying the
  ciphertexts and encrypted receipts. *Remove it → no payment rail, no on-chain policy, no audit.*
- **Ledger — AI Agents.** The issuer authority key lives on the device (Ledger **Device
  Management Kit** / Agent Stack, run headless on Speculos) and signs the schedule with one
  on-device confirmation. The agent never holds it. *Remove it → the schedule has no trusted
  signer.*
- **Bazantic — Agentify a New API.** The capability is an MCP server (`notyet_status`,
  `notyet_pay`) so other agents pay through Notyet — A2A payments that inherit the timelock's
  one-period blast radius. *Remove it → the capability isn't reachable by other agents.*

> Root of trust moved from ENS to Hedera/HCS to keep the critical path single-chain. The
> ENS integration (human-readable identity + ENSIP-25/26 agent records) is preserved on the
> [`ens`](https://github.com/0xkeccak/NotYet/tree/ens) branch as an optional layer.

## Repo layout

```
sdk/       tlock · pay · hcs · receipts · sign · types  (index = public SDK)
issuer/    schedule · derive · lock · ledger (DMK signer) · publish (to HCS)
agent/     resolve (read + verify the schedule from HCS)
service/   x402-gated price feed (Blocky402)
web/       dashboard API (server) + editorial landing/demo (public/index.html)
bazantic/  mcp-server (notyet_status + notyet_pay) · recipe.md
scripts/   day1-gate · test-core · test-ledger · e2e · full-demo · speculos-up · deploy
start.ts   one-process entry (service + web) for hosting
```

## Honest claims

See [`LIMITS.md`](./LIMITS.md). Short version: after issuance a period's key doesn't
exist in decryptable form before its round (for anyone); no *persistent* server holds
future keys; loss is bounded to one period. We do **not** claim device-less signing (we
use Speculos, which Ledger states qualifies in full), revocation before a period starts,
protection after unlock, or novel cryptography. We found no prior implementation of
timelocked cryptographic agent spend authority — we don't claim "no one has built this."
