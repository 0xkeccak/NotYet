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

- **Ledger (Device Management Kit / Speculos)** — *root of authority.* The issuer key signs
  the schedule with an on-device confirmation. The agent never holds it; a tampered schedule
  fails verification.
- **drand / tlock** — *the lock.* Binds each key to a wall-clock moment. No key server.
- **Hedera** — *root of trust + money + audit.* One HCS topic carries the signed schedule
  (the agent reads it back and **refuses** unless it recovers to the trusted issuer), the
  ciphertexts, and the encrypted receipts. One funded account per period is a ledger-enforced
  budget cap. x402 payments settle via the keyless Blocky402 facilitator.
- **MCP / Bazantic** — *reach.* The capability is exposed as MCP tools so other agents can
  pay through Notyet, inheriting the one-period blast radius.

One chain, **no bridge**: Hedera holds value, the audit log, *and* the rules the agent
verifies. The trust anchor is simply the issuer address the agent is configured to trust —
there is nothing to bridge. (An optional human-readable ENS identity layer, using ENSIP-25/26
agent text records, lives on the `ens` branch.)

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

Each period's **view key** is HKDF-derived from a master secret (`issuer/derive.ts`).
A receipt is sealed with NaCl secretbox under that view key. Hand out one period's view
key and only that period's receipts decrypt; every other message on the topic stays
ciphertext. Auditability without a global spy key.

## Stopping

There is no revoke message. The owner simply stops issuing — the agent's future never
arrives. A kill switch made of silence.

See [`LIMITS.md`](./LIMITS.md) for the exact honest claims (e.g. the issuer machine does
hold every plaintext key for a few seconds during issuance; loss is bounded to one
period, not zero; no revocation *after* a period has started).
