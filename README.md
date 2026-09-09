# Notyet ⏳

**Scheduled agent spend authority where the key doesn't exist until its time.**

> Tuesday's key does not exist until Tuesday.

Built for **ETHOnline 2026** · Hedera · Ledger · ENSv2. Everything below runs **live on
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
| **Ledger** (Speculos) | Issuer key signs the schedule with an on-device confirmation | `scripts/test-ledger.ts` |
| **ENS** (ENSv2, Sepolia) | Publishes the signed schedule + issuer address; the agent verifies and refuses on mismatch | `scripts/test-ens.ts` |
| **Hedera** | Holds each period's budget (one account/period), carries ciphertexts + encrypted receipts on HCS, settles x402 payments via Blocky402 | `scripts/day1-gate.ts`, `scripts/e2e.ts` |

Two chains, no bridge: ENS on Sepolia *names* the agent and holds its rules; Hedera holds
the money and the log. The ENS record just points to the Hedera account / HCS topic.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the two-key model, trust boundaries, and
the issue / spend / audit flows.

## What's live

- **ENS name (root of trust):** `mujahid.eth` on Sepolia (ENSv2), text records
  `notyet:schedule` + `notyet:issuer`.
- **Ledger issuer (Speculos):** address `0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D`.
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
#   ISSUER: Ledger signs -> Hedera period accounts + HCS -> publish to ENS
#   AGENT : resolve+verify from ENS -> NOT_YET on a future period -> unlock -> x402 pay
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

> **Live URL:** _pending first deploy_ — Railway free tier pins builds to `sfo`, which is
> unavailable during PT peak hours (8am–8pm); `scripts/deploy.sh` waits out that window.

Gate checks (the load-bearing primitives, verified against live services):

```bash
npm run gate                  # tlock roundtrip + decrypted-key Hedera settlement
npx tsx scripts/test-core.ts  # 17 offline checks (schedule, sign/verify, scoped receipts)
```

### .env

`HEDERA_PAYER_ID` / `HEDERA_PAYER_KEY` (ECDSA, from portal.hedera.com faucet),
`HEDERA_MERCHANT_ID`, `SEPOLIA_RPC_URL`, `ENS_OWNER_KEY`, `ENS_NAME`. Secrets stay in
`.env` (gitignored) — never committed.

## The three tracks — each load-bearing

- **Hedera — AI & Agentic Payments.** Real x402 payments via Blocky402 from per-period
  accounts; HCS carries the ciphertexts and encrypted receipts (verifiable audit trail);
  one account per period = a ledger-enforced budget cap. *Remove it → no payment rail, no
  audit log, no cap.*
- **Ledger — AI Agents.** The issuer authority key lives on the (emulated) device and
  signs the schedule with an on-device confirmation. The agent never holds it. *Remove it
  → the schedule has no trusted signer.*
- **ENSv2 — Best Use.** `mujahid.eth` holds the signed schedule + issuer address; the
  agent reads its rules there and **refuses** if the signature doesn't verify. *Remove it
  → the agent has no schedule to trust.*

## Repo layout

```
sdk/       tlock · ens · pay · hcs · receipts · sign · types
issuer/    schedule · derive · lock · ledger (Speculos signer) · publish
agent/     resolve (read + verify from ENS)
service/   x402-gated price feed (Blocky402)
web/       dashboard API (server) + editorial landing/demo (public/index.html)
scripts/   day1-gate · test-core · test-ens · test-ledger · e2e · full-demo · speculos-up · deploy
start.ts   one-process entry (service + web) for hosting
```

## Honest claims

See [`LIMITS.md`](./LIMITS.md). Short version: after issuance a period's key doesn't
exist in decryptable form before its round (for anyone); no *persistent* server holds
future keys; loss is bounded to one period. We do **not** claim device-less signing (we
use Speculos, which Ledger states qualifies in full), revocation before a period starts,
protection after unlock, or novel cryptography. We found no prior implementation of
timelocked cryptographic agent spend authority — we don't claim "no one has built this."
