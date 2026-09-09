# Honest claims and limits

## We claim

- After issuance, a period's spend key does not exist in decryptable form before that
  period starts — for anyone, the owner included.
- No *persistent* server holds future keys; after issuance, no party can be coerced into
  releasing a key early.
- Loss from a compromised agent is bounded by one period's account balance.
- Audit disclosure is scoped per period — one view key reveals one period, nothing else.

## We do not claim

- **That no machine ever held the plaintext keys.** During issuance the issuer process
  holds every spend key in plaintext at once, in order to encrypt them — a momentary
  honeypot. We run issuance on the trusted (Key Ring) box and wipe immediately after.
  The window is seconds, not the lifetime of a secrets manager — but it exists.
- **Revocation or clawback**, before or after unlock. You can only *not issue* the next
  period (or not fund it). Giving the owner a co-signing key would let them spend anytime
  and break "not even the owner." We chose consistency over a kill switch.
- **Protection after unlock.** Once live, a period's key is a normal key for that period;
  blast radius is one account. Pair with spend limits at the service.
- **Novel cryptography.** tlock is drand's; the application to agent spend authority is
  ours. Not quantum-resistant (BLS/IBE, as drand states).

## Novelty

We found no direct implementation of timelocked cryptographic agent spend authority. We
do **not** claim "no one has ever built this."

## Prior art we build on

- tlock — *Practical Timelock Encryption from Threshold BLS* (Gailly, Melissaris, Romailler)
- drand / League of Entropy — the randomness beacon
- Hedera x402 scheme, Blocky402 facilitator, HIP-423 long-term Scheduled Transactions
- Ledger Agent Stack / Key Ring
