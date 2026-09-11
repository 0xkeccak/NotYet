/**
 * The whole Notyet story in one run, live on testnet — the demo backbone.
 *
 *  ISSUER  (Ledger + Hedera):
 *    create HCS topic -> deploy a PeriodVault (agent recipient + issuer as approver),
 *    deposit liquidity -> for each period: commit address(k_i) + budget + [start,end]
 *    window + perTxMax to the vault, timelock k_i, post ciphertext to HCS -> build schedule
 *    -> SIGN IT ON THE (emulated) LEDGER (DMK) -> publish the signed schedule to HCS.
 *  AGENT   (Hedera + tlock + x402):
 *    resolve schedule from HCS + verify the Ledger signature -> read ciphertexts -> try a
 *    future period early (NOT_YET) -> unlock period 0 on its round -> WITHDRAW from the vault
 *    with the unlocked key (window + ecrecover + budget enforced on-chain) -> pay the x402
 *    service from the agent account (HashScan) -> post an encrypted receipt.
 *  AUDIT:
 *    decrypt period 0's receipt with its view key; prove other keys can't read it.
 *
 * Prereqs: `bash scripts/speculos-up.sh`, `npx tsx service/server.ts`, and .env.
 * Run: npx tsx scripts/full-demo.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { createTopic, submitMessage, readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, encryptToRound, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { sealReceipt, openSealedReceipt } from "../sdk/receipts.js";
import { payX402 } from "../sdk/pay.js";
import { deployVault, commitPeriod, deposit, withdraw, signWithdraw, evmAddressOf, HEDERA_TESTNET_CHAINID } from "../sdk/vault.js";
import { ledgerIssuerAddress, signScheduleWithLedger, ledgerApproveWithdraw, ledgerViewKeyPair } from "../issuer/ledger.js";
import { publishSchedule } from "../issuer/publish.js";
import { resolveSchedule } from "../agent/resolve.js";
import type { Schedule, Receipt } from "../sdk/types.js";

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:4021/price";
const agentLabel = process.env.AGENT_ID ?? "notyet-demo";
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hedera = () =>
  Client.forTestnet()
    .setOperator(AccountId.fromString(payerId), PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")))
    .setDefaultMaxTransactionFee(new Hbar(20));

const BUDGET = 1_000_000n, PERTXMAX = 500_000n, WITHDRAW = 120_000n; // tinybar

// ---------- ISSUER ----------
console.log("== ISSUER ==");
const issuer = await ledgerIssuerAddress();
console.log("issuer (Ledger/DMK on Speculos):", issuer);

const c = hedera();
const topicId = await createTopic(c, "notyet-full");
console.log("HCS topic (audit log):", topicId);

// no-alias agent account receives withdrawals and pays x402 from them
const agentKeyObj = PrivateKey.generateECDSA();
const agentAcctId = (await (await new AccountCreateTransaction().setKeyWithoutAlias(agentKeyObj.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(c)).getReceipt(c)).accountId!.toString();
const agentEvm = "0x" + AccountId.fromString(agentAcctId).toSolidityAddress();
const { contractId: vaultId, contractEvm: vaultEvm } = await deployVault(c, { agentEvm, approverEvm: issuer, initialTinybar: 0 });
await deposit(c, vaultId, 20_000_000); // 0.2 HBAR liquidity
console.log(`PeriodVault ${vaultId} deployed (agent ${agentAcctId}, approver = issuer), funded 0.2 HBAR`);

const now = Date.now();
const rounds = [roundForTime(now + 10_000), roundForTime(now + 600_000)]; // p0 soon, p1 far
const periods = [];
for (let i = 0; i < rounds.length; i++) {
  const k = generatePrivateKey();
  const ciphertext = await encryptToRound(k.slice(2), rounds[i]);
  const start = Math.floor(roundUnlockMs(rounds[i]) / 1000) - 5;
  // #3 — the period's audit view key is born on the device: publish only its PUBLIC half
  // so the agent can seal receipts to it but can never read them back.
  const view = await ledgerViewKeyPair(i);
  const viewPubKey = Buffer.from(view.publicKey).toString("base64");
  await commitPeriod(c, vaultId, { i, signerEvm: evmAddressOf(k), budgetTinybar: BUDGET, start, end: start + 86_400, perTxMaxTinybar: PERTXMAX });
  await submitMessage(c, topicId, JSON.stringify({ index: i, vaultIndex: i, round: rounds[i], ciphertext, viewPubKey }));
  periods.push({ index: i, startMs: roundUnlockMs(rounds[i]), round: rounds[i], vaultContractId: vaultId, vaultIndex: i, viewPubKey, budget: BUDGET.toString() });
  console.log(`  period ${i}: committed key ${evmAddressOf(k).slice(0, 10)}… to vault #${i}, view key from device, round ${rounds[i]} -> HCS`);
}

const schedule: Schedule = { agentId: agentLabel, network: "hedera:testnet", asset: "0.0.0", hcsTopicId: topicId, issuerPubKey: issuer, periods, createdMs: now };
console.log("signing schedule on the emulated Ledger (DMK)…");
const signed = await signScheduleWithLedger(schedule);
const seq = await publishSchedule(c, topicId, signed);
console.log(`  signed schedule on HCS (seq ${seq})`);

// ---------- AGENT ----------
console.log("\n== AGENT ==");
await sleep(6000); // let the mirror node index the topic
const resolved = await resolveSchedule(topicId, issuer);
console.log(`resolved + verified schedule (issuer ${resolved.issuerPubKey.slice(0, 10)}…, ${resolved.periods.length} periods)`);

const msgs = await readMessages(topicId);
const cts = msgs.map((m) => { try { return JSON.parse(m.contents); } catch { return null; } }).filter((x) => x && x.ciphertext);
console.log(`read ${cts.length} locked periods from HCS`);

try {
  await decryptCiphertext(cts[1].ciphertext);
  console.log("UNEXPECTED: period 1 decrypted early");
} catch (e) {
  console.log("period 1 →", isNotYet(e) ? `NOT_YET — key does not exist until round ${cts[1].round}` : (e as Error).message);
}

const p0 = cts[0];
const waitMs = Math.max(0, roundUnlockMs(p0.round) - Date.now()) + 4000;
console.log(`waiting ${Math.round(waitMs / 1000)}s for period 0's round…`);
await sleep(waitMs);
const spendKey = (await decryptCiphertext(p0.ciphertext)).toString("utf8");
console.log("period 0 unlocked — withdrawing from the vault (window + ecrecover + budget enforced on-chain)…");
const sig = await signWithdraw(spendKey, { contractEvm: vaultEvm, chainId: HEDERA_TESTNET_CHAINID, i: p0.vaultIndex, amtTinybar: WITHDRAW, spentTinybar: 0n, tag: "agent" });
const wstatus = await withdraw(c, vaultId, { i: p0.vaultIndex, amtTinybar: WITHDRAW, agent: sig });
console.log(`  withdraw: ${wstatus} — funds released to the agent account ${agentAcctId}`);
console.log("paying x402 service from the released funds…");
const result = await payX402(SERVICE_URL, { accountId: agentAcctId, privateKey: agentKeyObj.toStringRaw() });
console.log("paid:", result.paid, "| data:", JSON.stringify(result.data));
if (result.hashscan) console.log("HashScan:", result.hashscan);

// ---------- HUMAN-IN-THE-LOOP CEILING (Ledger) ----------
// Small spends are autonomous; a single withdrawal over perTxMax needs the owner's Ledger.
const bigAmt = PERTXMAX + 100_000n; // just over the ceiling
const bigSig = () => signWithdraw(spendKey, { contractEvm: vaultEvm, chainId: HEDERA_TESTNET_CHAINID, i: p0.vaultIndex, amtTinybar: bigAmt, spentTinybar: WITHDRAW, tag: "agent" });
console.log(`\nagent requests an OVER-CAP withdrawal (${bigAmt} > perTxMax ${PERTXMAX})…`);
try {
  await withdraw(c, vaultId, { i: p0.vaultIndex, amtTinybar: bigAmt, agent: await bigSig() });
  console.log("  UNEXPECTED: over-cap succeeded without the device");
} catch {
  console.log("  blocked on-chain — the contract requires the approver (Ledger) co-signature");
}
console.log("  owner approves on the Ledger (DMK tap)…");
const approver = await ledgerApproveWithdraw({ contractEvm: vaultEvm, chainId: HEDERA_TESTNET_CHAINID, i: p0.vaultIndex, amtTinybar: bigAmt, spentTinybar: WITHDRAW });
const bstatus = await withdraw(c, vaultId, { i: p0.vaultIndex, amtTinybar: bigAmt, agent: await bigSig(), approver });
console.log(`  over-cap withdraw WITH device co-sign: ${bstatus} — the explicit-approval boundary, on-chain`);
c.close();

// #3 — the agent seals the receipt to the period's PUBLIC view key; it cannot reopen it.
const receipt: Receipt = { periodIndex: 0, service: "price", amount: "100000", timestampMs: Date.now(), resultHash: "demo" };
await submitMessage(hedera(), topicId, sealReceipt(receipt, Uint8Array.from(Buffer.from(p0.viewPubKey, "base64"))));
console.log("sealed receipt -> HCS (only a Ledger tap can open it)");

// ---------- AUDIT ----------
console.log("\n== AUDIT ==");
await sleep(4000);
const all = await readMessages(topicId);
// The books open only with a Ledger tap: reconstruct period 0's secret view key on the
// device, decrypt its receipt — and prove period 1's device key cannot read it.
console.log("owner taps the Ledger to reconstruct period 0's view key…");
const v0 = await ledgerViewKeyPair(0);
const v1 = await ledgerViewKeyPair(1);
let read = 0, blockedWithNeighbor = 0;
for (const m of all) { try { openSealedReceipt(m.contents, v0.secretKey); read++; } catch {} }
for (const m of all) { try { openSealedReceipt(m.contents, v1.secretKey); } catch { blockedWithNeighbor++; } }
console.log(`period 0 device key opened ${read} receipt(s); ${blockedWithNeighbor}/${all.length} messages unreadable with period 1's key`);

console.log("\nFULL DEMO OK — Ledger (DMK) signed schedule + approved over-cap spend + holds the audit keys · HCS-verified trust · timelock enforced · PeriodVault withdraw on-chain · Hedera settled · device-scoped audit");
process.exit(result.paid ? 0 : 1);
