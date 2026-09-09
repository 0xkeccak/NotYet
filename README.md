# Notyet ⏳

**Scheduled agent spend authority where the key doesn't exist until its time.**

> Tuesday's key does not exist until Tuesday.

Built for ETHOnline 2026 · Hedera · Ledger · ENSv2 · Bazantic.

---

## The problem

Autonomous agents need to spend on a schedule — daily budgets, per-shift API
credits, windowed signing rights. Every option today is broken:

- **Hand the agent everything up front** → a hacked or prompt-injected agent burns
  the whole budget at once.
- **A server releases keys just-in-time (cron / secrets manager)** → that server holds
  *every future key*. It is the honeypot, the single point of failure, and the
  coercion target.

Session keys and delegations solve *expiry* — an agent's authority can end. Nothing
solves *start*: an agent's authority always exists the moment it is issued.

## The idea

**Timelock encryption (tlock).** Each period's spend key is encrypted to a future round
of the [drand](https://drand.love) beacon — a threshold network publishing a BLS
signature every 3 seconds. That signature *is* the decryption key, and it does not exist
until the round happens. Nobody can decrypt early — not the agent, not the owner, not
drand.

The owner pre-issues the whole schedule, hands the agent every *locked* key now, and
walks away. Each key unlocks itself on time. Stop issuing → the agent's future never
arrives. A kill switch with no kill message.

## How the pieces fit

| Layer | Role |
|---|---|
| **Ledger** | Master key signs the schedule (root of trust). Never spends. |
| **ENS** (`keccak.eth`) | Publishes the signed schedule + issuer pubkey. The agent reads its rules here and refuses if the signature fails. |
| **drand / tlock** | Encrypts each spend key to a future round. The lock itself. |
| **Hedera** | Holds the money, carries the locked keys + encrypted receipts on HCS, and settles the x402 payment. |

Two chains, no bridge: ENS on Sepolia *names* the agent and holds the rules; Hedera holds
the money. The ENS record just points to the Hedera account and HCS topic.

## Status

Work in progress — ETHOnline 2026 build. See [`LIMITS.md`](./LIMITS.md) for honest claims
and non-claims.
