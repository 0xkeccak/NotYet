# Demo video script (≤ 4 min, no speed-up)

Record real-time, no cuts that hide timing (ETHGlobal rule). Two sources:
- **UI** — `https://notyet.up.railway.app` (or `npm run web` locally) for the live loop.
- **Terminal** — `npm run demo` (`scripts/full-demo.ts`) for the three Ledger device authorities.

Lead with the money shot. Every segment below names the track it scores.

---

## 0:00–0:20 · Hook
Say: *"Autonomous agents need to spend on a schedule. Hand it the whole budget and one hack
drains everything; run a key server and that server is a honeypot holding every future key.
NotYet fixes the thing nobody else does — the key for a future period **doesn't exist yet**."*
Show: the landing hero — **"Tuesday's key doesn't exist until Tuesday."**

## 0:20–0:55 · The money shot (the whole idea)
Show (UI "Run it live" or terminal): try to spend a locked period →
`Error: NOT_YET — key for period N does not exist until round …`
Say: *"That's not a permission check. The decryption key hasn't been published by the drand
beacon yet — it exists for no one, not even me. Nothing to steal, nothing to leak, nothing to
coerce."* Let it sit on screen.

## 0:55–2:05 · The full loop, real on Hedera  ← **HEDERA track**
Show the run end to end:
1. **Issue** — a 2-period schedule; keys committed to the on-chain **PeriodVault**, tlock-encrypted, posted to HCS.
2. **NOT_YET** on the future period (again, briefly).
3. **Clock ticks** — wait for the real drand round (show the seconds count down).
4. **Withdraw** — the unlocked key withdraws from the vault; the contract enforces window + budget + `ecrecover` **on-chain**.
5. **Settle** — a real **x402** payment via the keyless **Blocky402** facilitator. **Open the HashScan link.**
Say the Hedera bonus lines out loud: *"Real metered x402, on-chain policy in the PeriodVault,
HCS audit trail, and a HIP-423 scheduled-transaction mode — all on one chain, no bridge."*

## 2:05–3:00 · The device holds authority  ← **LEDGER track**
Switch to the `npm run demo` terminal (or show the device screens on the site). Show the three
things only the Ledger can do:
1. **Signs the schedule** — one on-device tap is the root of trust; tamper with the rules and the agent refuses.
2. **Co-signs over-cap spends** — a spend above the per-tx ceiling **reverts on-chain** until the device approves (`gate:vault:ledger` — 3/3). Show the device prompt.
3. **Holds the audit keys** — receipts are sealed to a device-derived key the agent **provably can't reopen**; only a device tap opens one period's books.
Say the strongest sentence: *"The agent seals its own logs to a key it can never open — it
cannot forge or hide its own audit trail."* Mention: Ledger **Device Management Kit**, headless
on Speculos, deterministic (RFC 6979), plus an **ERC-7730** clear-signing descriptor.

## 3:00–3:40 · Any agent can adopt it  ← **BAZANTIC track**
Show: `claude mcp add notyet …` then the four tools; and the published **Bazantic recipe**
chaining **two services** — NotYet (issue → unlock → pay) and the **Hedera Mirror Node**
(independent settlement confirmation). Then: *"And it's a real SDK — `npm i @keccak002/notyet`."*
Say: *"Any agent adopts time-gated spend authority in one line and inherits the one-period
blast radius for free."*

## 3:40–4:00 · Close
Say: *"Hacked today, an agent loses one period's budget — never the treasury, never a future
period. That's the guarantee, enforced by cryptography and an on-chain contract, not by trust.
**Tuesday's key doesn't exist until Tuesday.**"*
Show: the blast-radius line + tagline.

---

## What each judge is scoring — hit these explicitly
- **Hedera:** a live x402-gated service settled via Blocky402 (open HashScan), an agent making a
  real paid call end-to-end, PeriodVault on-chain gating, HCS audit, HIP-423 mode. Show the tx.
- **Ledger:** device-only authority (sign · co-sign over-cap · hold audit keys), secrets the
  agent can't leak, human approval before an irreversible over-cap spend, DMK + Speculos (no
  hardware needed), ERC-7730. Show a device screen.
- **Bazantic:** the capability agentified as a gateway + MCP, a reusable recipe using two
  services, installable SDK — "any agent integrates easily."

## Do / don't
- **Do** open at least one **HashScan** link live (proves it's real, not a slideshow).
- **Do** keep it real-time through the NOT_YET → unlock wait (that wait *is* the proof).
- **Don't** speed up or cut the timing. **Don't** show any private key or `.env`.
- Put the Bazantic username **`0xkeccak`** in the ETHGlobal submission form.
