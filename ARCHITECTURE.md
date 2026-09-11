# Architecture

How Notyet turns "spend authority on a schedule" into a cryptographic fact instead of a
trusted server. One idea does the heavy lifting: **a period's spend key is timelock-
encrypted to a future drand round, so it does not exist in usable form before its time.**

## Two keys, two jobs

| Key | Lives on | Job | Ever timelocked? |
|---|---|---|---|
| **Issuer key** | Ledger (Speculos) | Signs the schedule so the agent can trust it; derives per-period view keys. Never spends. | No |
| **Spend key** (one per period) | Nowhere, until its round | Controls that period's Hedera account; signs the x402 payment. | **Yes** — this is the one thing that gets encrypted to the future |

The agent holds every period's *ciphertext* from day one. It holds no period's *plaintext
spend key* until that period's drand round publishes the signature that decrypts it.

## The lock

drand (quicknet) publishes a BLS signature every 3s. tlock encrypts to a future round `r`;
the round-`r` signature *is* the decryption key. Before round `r` that signature does not
exist — so the ciphertext is undecryptable for **everyone**, including the issuer. Decrypt
early and the SDK throws `NOT_YET`. This is not a permission check; there is no key to
check against yet.

```
period i  ──tlock.encrypt(spendKey_i, round_i)──▶  ciphertext_i   (public, on HCS)
                                                        │
        drand reaches round_i  ──▶ signature_i  ────────┘  decrypts ──▶ spendKey_i
```

## Trust boundaries (which track secures what)

- **Ledger (Device Management Kit / Speculos)** — *root of authority.* One device key holds
  three authorities the agent never gets: it **signs the schedule** (a tampered schedule
  fails verification), it is the vault's on-chain **approver** that must **co-sign any
  withdrawal over `perTxMax`** (proven live in `scripts/test-vault-ledger.ts`, 3/3), and it
  **reconstructs the per-period audit view keys** on a device tap (the agent seals receipts
  to the public half and can never reopen them — `issuer/ledger.ledgerViewKeyPair`).
- **drand / tlock** — *the lock.* Binds each key to a wall-clock moment. No key server.
- **Hedera** — *root of trust + money + audit.* One HCS topic carries the signed schedule
  (the agent reads it back and **refuses** unless it recovers to the trusted issuer), the
  ciphertexts, and the encrypted receipts. The budget cap is enforced by the **PeriodVault**
  contract (`spent_i ≤ budget_i`, on-chain, HashScan-visible) — see below. x402 payments
  settle via the keyless Blocky402 facilitator.
- **MCP / Bazantic** — *reach.* The capability is exposed as MCP tools so other agents can
  pay through Notyet, inheriting the one-period blast radius.

One chain, **no bridge**: Hedera holds value, the audit log, *and* the rules the agent
verifies. The trust anchor is simply the issuer address the agent is configured to trust —
there is nothing to bridge. (An optional human-readable ENS identity layer, using ENSIP-25/26
agent text records, lives on the `ens` branch.)

## Settlement — PeriodVault (one contract, not N wallets)

The spend authority is gated by **time in a contract**, not by a funded account per period.
One `PeriodVault` on Hedera EVM holds the treasury; the owner commits a schedule:

```
periods[i] = { signer: address(k_i), budget, [start, end], perTxMax, spent }
```

`k_i` is generated in software, its address committed on-chain, then timelock-encrypted and
wiped — so the agent holds only ciphertexts. To spend, the agent calls
`withdraw(i, amt, sig)`; the contract requires, on-chain:

- **window** — `start_i ≤ now ≤ end_i` (a key is useless before *and* after its period),
- **identity** — `ecrecover(digest) == address(k_i)` (proves possession of the unlocked key),
- **budget** — `spent_i + amt ≤ budget_i`,
- **HITL** — if `amt > perTxMax_i`, the owner's Ledger key (`approver`) must co-sign — the
  explicit-approval boundary above the autonomous ceiling.

The signature is domain-bound (contract, chainid, i, amt, spent-nonce, role) so it can't be
replayed. `reclaim(i)` returns the unspent remainder to the owner **only after `end_i`** — the
owner can get their money back but can never pull a live period forward. One account, one
readable policy; a compromised agent still loses at most one period's budget.

> Rollout note: the contract (`contracts/PeriodVault.sol`), client (`sdk/vault.ts`) and gate
> (`scripts/test-vault.ts`) are complete and the **on-chain gate passes 5/5 live** on Hedera
> testnet (window / budget / ecrecover(k_i) / perTxMax-escalation all enforced; a withdrawal
> moved real HBAR). A persistent showcase vault with a committed schedule is deployed at
> `0.0.10469008` (approver = the Ledger issuer). The interactive landing demo still exercises
> the timelock→x402 path directly; the vault is surfaced as a live, inspectable proof.

## Flow 1 — Issue (Human → Agent, once)

```
Owner sets a rule ("$5 each period, N periods")
  1. Ledger signs the schedule                         (issuer/ledger.ts)
  2. For each period i:
       create + fund a Hedera account with a fresh spend key   (issuer/lock.ts)
       tlock-encrypt spendKey_i to round_i; wipe the plaintext
       submit ciphertext_i to the HCS topic                    (sdk/hcs.ts)
  3. Post the signed schedule to the HCS topic (issuer/publish.ts)
Owner now holds nothing usable. Walk away.
```

## Flow 2 — Spend (Agent → Agent, per period, autonomous)

```
  1. Resolve rules from HCS, verify issuer signature — refuse on mismatch  (agent/resolve.ts)
  2. Fetch ciphertext_i from HCS
  3. tlock.decrypt(ciphertext_i):
        before round_i  ─▶ throws NOT_YET   (the money shot)
        on/after round_i ─▶ spendKey_i
  4. Call the x402 service → 402 → sign payment from the period account → Blocky402
     settles on Hedera → receive the resource + a HashScan settlement link  (sdk/pay.ts)
  5. Encrypt a receipt with the period's view key; submit to HCS; discard the key
```

## Flow 3 — Audit (scoped, after the fact)

Two implementations, same scoping property:

- **Device-born (the `npm run demo` path).** Each period's view keypair is derived from a
  Ledger signature over `notyet:view:<i>` — deterministic (RFC 6979), so the same tap always
  yields the same key, but the secret **never touches disk**. Only the *public* half is
  published; the agent **seals** each receipt to it (`sealReceipt`, ephemeral-X25519 box) and
  can never reopen it. Opening period *i*'s books is one on-device tap
  (`ledgerViewKeyPair(i)` → `openSealedReceipt`), scoped to that period alone.
- **Software fallback (the hosted dashboard).** Where no device is attached, each view key is
  HKDF-derived from a master secret (`issuer/derive.ts`) and receipts use NaCl secretbox
  (`encryptReceipt`). Same "one key reveals one period" guarantee, no hardware.

Either way: hand out one period's view key and only that period's receipts decrypt; every
other message on the topic stays ciphertext. Auditability without a global spy key.

## Stopping

There is no revoke message. The owner simply stops issuing — the agent's future never
arrives. A kill switch made of silence.

See [`LIMITS.md`](./LIMITS.md) for the exact honest claims (e.g. the issuer machine does
hold every plaintext key for a few seconds during issuance; loss is bounded to one
period, not zero; no revocation *after* a period has started).
