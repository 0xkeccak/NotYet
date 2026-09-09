/**
 * The whole Notyet story in one run, live on testnet — the demo backbone.
 *
 *  ISSUER  (Ledger + Hedera + ENS):
 *    create HCS topic -> issue N period accounts (fund + timelock spend key) -> post
 *    ciphertexts to HCS -> build schedule -> SIGN IT ON THE (emulated) LEDGER ->
 *    publish signed schedule to ENS.
 *  AGENT   (ENS + tlock + Hedera x402):
 *    resolve schedule from ENS + verify Ledger signature -> read ciphertexts from HCS ->
 *    try a future period early (NOT_YET) -> unlock period 0 on its round -> pay the x402
 *    service from period 0's account (HashScan) -> post an encrypted receipt.
 *  AUDIT:
 *    decrypt period 0's receipt with its view key; prove other keys can't read it.
 *
 * Prereqs: `bash scripts/speculos-up.sh`, `npx tsx service/server.ts`, and .env.
 * Run: npx tsx scripts/full-demo.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { issuePeriod } from "../issuer/lock.js";
import { createTopic, submitMessage, readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
import { encryptReceipt, decryptReceipt } from "../sdk/receipts.js";
import { payX402 } from "../sdk/pay.js";
import { ledgerIssuerAddress, signScheduleWithLedger } from "../issuer/ledger.js";
import { publishSchedule } from "../issuer/publish.js";
import { resolveSchedule } from "../agent/resolve.js";
import type { Schedule, Receipt } from "../sdk/types.js";

const rpc = process.env.SEPOLIA_RPC_URL!;
const ownerKey = process.env.ENS_OWNER_KEY as `0x${string}`;
const ensName = process.env.ENS_NAME ?? "mujahid.eth";
const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:4021/price";
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hedera = () => Client.forTestnet().setOperator(AccountId.fromString(payerId), PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")));

// ---------- ISSUER ----------
console.log("== ISSUER ==");
const issuer = await ledgerIssuerAddress();
console.log("issuer (Ledger/Speculos):", issuer);

const c = hedera();
const topicId = await createTopic(c, "notyet-full");
console.log("HCS topic:", topicId);

const now = Date.now();
const rounds = [roundForTime(now + 10_000), roundForTime(now + 600_000)]; // p0 soon, p1 far
const master = newMasterViewSecret();
const periods = [];
for (let i = 0; i < rounds.length; i++) {
  const p = await issuePeriod(c, { index: i, round: rounds[i], budgetTinybars: "3000000" });
  await submitMessage(c, topicId, JSON.stringify({ index: i, round: rounds[i], accountId: p.accountId, ciphertext: p.ciphertext }));
  periods.push({ index: i, startMs: now + i * 90_000, round: rounds[i], hederaAccountId: p.accountId, budget: "50000000" });
  console.log(`  period ${i}: account ${p.accountId}, round ${rounds[i]} -> HCS`);
}

const schedule: Schedule = {
  ensName, network: "hedera:testnet", asset: "0.0.0", hcsTopicId: topicId,
  issuerPubKey: issuer, periods, createdMs: now,
};
console.log("signing schedule on the emulated Ledger…");
const signed = await signScheduleWithLedger(schedule);
console.log("publishing signed schedule to", ensName, "…");
const pub = await publishSchedule(rpc, ownerKey, ensName, signed);
console.log("  ENS records:", pub.issuerTx.slice(0, 12) + "…,", pub.scheduleTx.slice(0, 12) + "…");
c.close();

// ---------- AGENT ----------
console.log("\n== AGENT ==");
await sleep(6000); // let ENS + HCS settle on the public RPC / mirror
const resolved = await resolveSchedule(rpc, ensName);
console.log(`resolved + verified schedule from ${ensName} (issuer ${resolved.issuerPubKey.slice(0, 10)}…, ${resolved.periods.length} periods)`);

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
console.log("period 0 unlocked — paying x402 service from", p0.accountId);
const result = await payX402(SERVICE_URL, { accountId: p0.accountId, privateKey: spendKey });
console.log("paid:", result.paid, "| data:", JSON.stringify(result.data));
if (result.hashscan) console.log("HashScan:", result.hashscan);

const receipt: Receipt = { periodIndex: 0, service: "price", amount: "100000", timestampMs: Date.now(), resultHash: "demo" };
await submitMessage(hedera(), topicId, encryptReceipt(receipt, deriveViewKey(master, 0)));
console.log("encrypted receipt -> HCS");

// ---------- AUDIT ----------
console.log("\n== AUDIT ==");
await sleep(4000);
const all = await readMessages(topicId);
const v0 = deriveViewKey(master, 0);
let read = 0, blockedWithNeighbor = 0;
for (const m of all) { try { decryptReceipt(m.contents, v0); read++; } catch {} }
for (const m of all) { try { decryptReceipt(m.contents, deriveViewKey(master, 1)); } catch { blockedWithNeighbor++; } }
console.log(`period 0 view key decrypted ${read} receipt(s); ${blockedWithNeighbor}/${all.length} messages unreadable with period 1's key`);

console.log("\nFULL DEMO OK — Ledger signed · ENS verified · timelock enforced · Hedera settled · scoped audit");
process.exit(result.paid ? 0 : 1);
