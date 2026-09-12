# Ledger DX feedback — NotYet (ETHOnline 2026)

Running log of developer-experience friction and wins while building NotYet's Ledger
integration. Kept updated as we hit things; each entry is a real, dated observation from
this build, not a hypothetical.

**Stack used:** `@ledgerhq/device-management-kit` (DMK) + `@ledgerhq/device-signer-kit-ethereum`
+ `@ledgerhq/device-transport-kit-speculos`, running the Ethereum app on **Speculos**
(headless, no hardware). Also evaluated `@ledgerhq/wallet-cli` (Key Ring). Node 22, TS ESM
via `tsx`. Goal: an **agent** that signs a spend schedule and, in the vault redesign,
co-signs high-value withdrawals — with a clear on-device screen (ERC-7730).

Legend: 🟥 blocker · 🟧 slowed us down · 🟩 worked well.

---

## 1. 🟧 "Which library?" — hw-app-eth vs DMK vs wallet-cli is not obvious for an *agent*
The Agent Stack / headless-signing story spans three libraries and it took real reading to
learn which applies:
- `@ledgerhq/hw-app-eth` — legacy `AppEth`, still all over search results and tutorials.
- **DMK** (`device-management-kit` + `device-signer-kit-ethereum`) — the current path,
  meant to replace `hw-app-XXX`, and the one that supports Speculos headless.
- `wallet-cli` **Key Ring** (`ring init`) — USB-only.

We initially built against `hw-app-eth`, then migrated to DMK. **Suggested fix:** a single
"Signing from a server/agent (no USB)" page that says up front: *use DMK + the Speculos
transport; hw-app-eth is legacy; Key Ring needs USB.* One decision tree would have saved a
half-day.

## 2. 🟥 `wallet-cli` Key Ring is USB-only — no Speculos path
`ring init` and the Key Ring flows assume a physically attached device; there's no Speculos
transport for wallet-cli. For a **hosted agent** (the exact scenario the track calls out),
that's a hard stop. We routed all headless signing through DMK instead. **Suggested fix:**
a Speculos/emulator transport for wallet-cli, or docs stating clearly that Key Ring is
hardware-only so people don't start there for a server workload.

## 3. 🟧 DMK method naming — `signPersonalMessage` doesn't exist
Coming from `hw-app-eth`'s `signPersonalMessage`, the DMK Ethereum signer uses
`signMessage(derivationPath, message)`. The rename isn't surfaced in migration examples we
found; we discovered it from the type definitions. **Suggested fix:** a hw-app-eth → DMK
method-mapping table in the migration guide.

## 4. 🟧 DMK is observable-first (rxjs) — unfamiliar for a request/response call
Actions return observables you subscribe to and drive to completion, rather than awaitable
promises. For a one-shot "sign this" in an agent loop we had to wrap the observable into a
promise ourselves. It works and is powerful, but a `firstValueFrom`-style
"await this action" helper in the signer kit would cut boilerplate. **Suggested fix:** ship
a promise wrapper for the common "run to completion" case.

## 5. 🟧 Speculos automation — button-press API works but is undocumented in the kit
Auto-confirming the on-device prompt from tests needs Speculos's HTTP button API
(`/button/right`, `/button/both`). The DMK Speculos transport connects fine, but the
"how do I approve the prompt in CI" story lives outside the kit docs. We wired it manually.
Also hit a **hang on connect** when a previous Speculos session was still holding the app —
killing and restarting the emulator fixed it. **Suggested fix:** document the CI approval
loop in the Speculos transport README; surface a clearer error on a stale session.

## 6. 🟩 DMK + Speculos genuinely qualifies "no hardware"
Once wired, the signing path is identical to a real device — same APDU flow, same on-device
confirmation (auto-pressed in the emulator). Pointing the same code at a plugged-in device
would sign there instead. For a hackathon with no device in hand, this was the difference
between "can't do the Ledger track" and "done." 🟩

## 7. 🟩 The security boundary is the right one — but it shaped our architecture
A Ledger **never exports a private key**. That's correct and non-negotiable — but it means
the device cannot *hold* a key we need to timelock-encrypt (we must possess the plaintext to
encrypt it). So the Ledger's honest role in NotYet is **authority**, not the spend money:
it signs the schedule and co-signs high-value withdrawals. Worth stating in docs that
"hardware-secured agent key" and "key the app can extract/escrow" are mutually exclusive —
it's an architecture decision people should make deliberately, not discover late (we did).

## 8. 🟧 ERC-7730 clear-signing — authoring is fine, validating/registering is the gap
We wrote a descriptor for `PeriodVault` (`contracts/PeriodVault.erc7730.json`) so the device
shows "Commit a spend period · Budget 0.5 HBAR · Opens <date>" instead of calldata. Friction:
- No obvious **local validator** to check the descriptor against the schema before shipping;
  we'd have caught field-path mistakes faster with a `npx @ledgerhq/erc7730 validate` command.
- The contract **address is unknown until deploy**, so the `deployments[]` entry is a
  placeholder we patch post-deploy — a `${DEPLOY_ADDRESS}` templating convention would help.
- The path from "descriptor in my repo" to "device actually shows it" (registry submission)
  isn't clear for a hackathon timeframe. **Suggested fix:** a "test your descriptor on
  Speculos without registry submission" flow.

## 9. 🟩 `perTxMax` escalation maps cleanly onto the HITL guideline (now wired + on-chain proven)
*(2026-09-11)* The track's "clear boundaries between autonomous behavior and explicit
approval" translated directly into one contract rule: withdrawals ≤ `perTxMax` are autonomous
(agent sig only); above it, the vault requires the **approver (Ledger) co-signature**. The
device tap *is* the boundary. This is no longer just in the contract — it's driven by the
real device end-to-end: `npm run gate:vault:ledger` deploys a vault with the Ledger address
as approver and proves on Hedera testnet that an over-cap withdrawal **reverts** with the
agent signature alone and **succeeds** only with the on-device co-sign (gate 3/3;
`scripts/test-vault-ledger.ts`). The same tap gates the over-cap step in `npm run demo`.

## 10. 🟧 Signing a RAW 32-byte digest via DMK — bytes vs string is a silent footgun
*(2026-09-11)* The contract's `ecrecover` expects an EIP-191 `personal_sign` over the raw
32-byte withdrawal digest (matching viem's `signMessage({ message: { raw } })`). DMK's
`signMessage(path, message)` happily takes a `string`, but a hex string is treated as UTF-8
text — so signing `"0x1a2b…"` personal-signs the *characters*, not the 32 bytes, and
`ecrecover` silently returns the wrong address (no error, just a failed `require`). The fix
was to pass a `Uint8Array` (`hexToBytes(digest)`) so the device signs the bytes. **Suggested
fix:** in the Ethereum signer kit, either reject ambiguous hex strings or document loudly
that raw-digest signing must pass bytes; a `signDigest`/`signRaw` helper would remove the
ambiguity entirely. We caught it only by recovering the address in a test before trusting it
on-chain.

## 11. 🟩 Deterministic ECDSA (RFC 6979) doubles as a device-bound KDF — but there's no first-class API
*(2026-09-11)* For the audit layer we wanted view keys that **never touch disk** and that only
the device can reconstruct. Because the Ethereum app signs deterministically (RFC 6979), a
`signMessage("notyet:view:<i>")` yields the *same* signature every time, which we HKDF into a
per-period X25519 keypair (`ledgerViewKeyPair`). The agent seals each receipt to the public
half and literally cannot reopen it; one device tap regenerates the secret for a scoped audit.
It works great — but we're **piggybacking on `signMessage`** to get a deterministic secret.
**Suggested fix:** a first-class "derive a deterministic app-scoped secret from a label" API
(à la BIP-85 / SLIP-0021) so this pattern doesn't rely on the signature-determinism side
effect and doesn't consume a user-facing "sign message" prompt.

## 12. 🟧 ERC-7730 clear-signing doesn't cover `personal_sign` digests — our HITL co-sign shows a blind hash
*(2026-09-11)* Our over-cap approval is an EIP-191 `personal_sign` over a packed keccak
digest (so it shares one `ecrecover` path with the agent signature). But ERC-7730 clear-signing
targets **transactions / EIP-712 typed data**, not `personal_sign` — so on Speculos the device
shows the approver a raw 32-byte hash, *not* "Approve withdrawal · Period 3 · 0.05 HBAR." To
get the legible screen we'd have to restructure the co-sign as EIP-712 typed data with a
matching descriptor. **Suggested fix:** extend ERC-7730 (or provide guidance) for structured
`personal_sign`/message payloads, so an agent's "approve this action" message can be clear-signed
without forcing it into an on-chain transaction shape. Until then, "make the human read what
they approve" and "reuse one ecrecover path" are in tension — worth a documented pattern.

## 13. 🟧 Making the Ledger the on-chain *owner* works — but needs blind signing, and clear-signing would fix it
*(2026-09-12)* We added a path where the Ledger is not just the approver but the vault's
on-chain **owner**: deploy / `commitPeriod` are submitted through the Hedera **JSON-RPC relay**
as ordinary EVM transactions **signed on the device** (`signTxWithLedger` + `sdk/vault-relay.ts`).
It works — we deployed a vault whose on-chain `owner()` and `approver()` are **both** the Ledger
address (`gate:vault:relay`), signed entirely on Speculos. Friction:
- **Contract-creation / contract-call txs require Blind signing = ON.** With it off, the app
  rejects them with `0x6a80` ("Invalid data") *before* any review screen — no hint that the
  toggle is the cause. A first-time dev will assume their transaction encoding is wrong. There's
  no clear-sign descriptor for an arbitrary `commitPeriod` call, so blind signing is unavoidable
  today. **Suggested fix:** when a contract tx is rejected for this reason, surface a distinct
  error ("enable Blind signing") rather than a generic `0x6a80`; and let an ERC-7730 descriptor
  cover these calls so the device can clear-sign instead of blind-sign.
- **Multi-transaction headless runs are fragile on the emulator.** Auto-approving via the
  Speculos button API is fine for a single signature, but across several blind-signed txs in one
  run the emulator is easy to leave mid-exchange (a killed process → `0x6980` on the next call)
  or to wander into Settings and flip Blind signing off between txs. A real device (a human
  pressing) sidesteps this; for CI, a documented "return to home after each action / set-setting
  via APDU" helper in the Speculos transport would make headless multi-tx flows reliable. We
  proved the deploy end-to-end; the combined deploy+commit run is the flaky one, purely from this.

---

### Summary for judges
DMK + Speculos let a **hosted agent** sign with Ledger-grade guarantees and **no hardware**,
and clean-signing via ERC-7730 makes the approval legible. The biggest time-sinks were
**library selection** (hw-app-eth vs DMK vs Key Ring) and **ERC-7730 tooling** (no local
validate). The security model (no key export) is right and we designed around it: Ledger
holds the *authority*, timelock/drand holds the *money's* timing.
