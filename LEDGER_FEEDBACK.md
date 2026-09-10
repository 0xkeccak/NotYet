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

## 9. 🟩 `perTxMax` escalation maps cleanly onto the HITL guideline
The track's "clear boundaries between autonomous behavior and explicit approval" translated
directly into one contract rule: withdrawals ≤ `perTxMax` are autonomous (agent sig only);
above it, the vault requires the **approver (Ledger) co-signature**. The device tap *is* the
boundary. Having a concrete on-chain threshold made the guideline implementable and demoable.

---

### Summary for judges
DMK + Speculos let a **hosted agent** sign with Ledger-grade guarantees and **no hardware**,
and clean-signing via ERC-7730 makes the approval legible. The biggest time-sinks were
**library selection** (hw-app-eth vs DMK vs Key Ring) and **ERC-7730 tooling** (no local
validate). The security model (no key export) is right and we designed around it: Ledger
holds the *authority*, timelock/drand holds the *money's* timing.
