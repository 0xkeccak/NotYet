# Honest claims and limits

## We claim

- After issuance, a period's spend key does not exist in decryptable form before that
  period starts — for anyone, the owner included.
- No *persistent* server holds future keys; after issuance, no party can be coerced into
  releasing a key early.
- Loss from a compromised agent is bounded by one period's account balance.
- Audit disclosure is scoped per period — one view key reveals one period, nothing else. In
  the device-born path (`npm run demo`) that view secret is reconstructed from a Ledger tap
  and **never touches disk**; the agent seals receipts to the public half and cannot reopen them.
- With **PeriodVault**, a period's key is useless **outside its [start, end] window** and
  **beyond its budget** — both enforced on-chain by the contract, not by convention.

## We do not claim

- **That no machine ever held the plaintext keys.** During issuance the issuer process
  holds every spend key in plaintext at once, in order to encrypt them — a momentary
  honeypot. We run issuance on the issuer host and wipe immediately after (the keys are
  never persisted). The window is seconds, not the lifetime of a secrets manager — but it
  exists. (Ledger Key Ring would be the natural at-rest store here, but it's USB-only with
  no headless path — see LEDGER_FEEDBACK.md — so this build uses in-process wipe instead.)
- **Revocation or clawback**, before or after unlock. You can only *not issue* the next
  period (or not fund it). Giving the owner a co-signing key would let them spend anytime
  and break "not even the owner." We chose consistency over a kill switch.
- **Total protection after unlock.** Within its live window a period's key can still spend
  up to that period's *remaining* budget, so a compromise mid-window costs at most that.
  PeriodVault bounds this three ways on-chain (window end, budget cap, `perTxMax` requiring
  the Ledger co-sign) — but it does not make an unlocked, in-window key un-spendable.
- *(Resolved 2026-09-11)* The PeriodVault gate is **green live on Hedera testnet** — deploy
  → deposit → in-window withdraw settles, and future-window / over-budget / over-`perTxMax`
  (without the approver) all revert on-chain. A withdrawal moved real HBAR to the recipient.
  The over-`perTxMax` co-sign is proven with the **real Ledger device** as approver, not a
  software stand-in: `npm run gate:vault:ledger` (3/3) shows the over-cap withdrawal revert
  with the agent signature alone and settle only with the on-device co-signature.
- **Novel cryptography.** tlock is drand's; the application to agent spend authority is
  ours. Not quantum-resistant (BLS/IBE, as drand states).
- **A physical Ledger device in this build.** The issuer key runs on **Speculos**,
  Ledger's official emulator — which Ledger explicitly states qualifies a submission in
  full. The signing path is identical to a hardware device (the on-device confirmation is
  auto-pressed via the Speculos button API; a real device confirms by hand). Point the
  same code at a plugged-in device and it signs there instead.
- **ENS as the root of trust on `main`.** It isn't — Hedera/HCS is. `main` is single-chain:
  the Ledger-signed schedule lives on an HCS topic and the agent verifies it against the
  issuer it's configured to trust. The ENS integration (human-readable identity + ENSIP-25/26
  agent text records, published live on `mujahid.eth`) is preserved on the `ens` branch as an
  optional identity layer, not a dependency. Note: ENSv2 *subname* creation on Sepolia is not
  possible with stable tooling today (`ensjs` v4 targets the classic registry) — the branch
  uses the ENS-blessed, text-record-based agent standards instead.

## Novelty

We found no direct implementation of timelocked cryptographic agent spend authority. We
do **not** claim "no one has ever built this."

## Prior art we build on

- tlock — *Practical Timelock Encryption from Threshold BLS* (Gailly, Melissaris, Romailler)
- drand / League of Entropy — the randomness beacon
- Hedera x402 scheme, Blocky402 facilitator, HIP-423 long-term Scheduled Transactions
- Ledger Agent Stack / Key Ring
