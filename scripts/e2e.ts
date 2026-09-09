/**
 * End-to-end product loop (compressed timing), all live on testnet:
 *   issuer: create 2 period accounts keyed to fresh spend keys, fund them, timelock
 *           each key to its round, post ciphertexts to HCS.
 *   agent:  read HCS -> try period 1 early (NOT_YET) -> unlock period 0 on its round
 *           -> pay the x402 service from period 0's account -> post encrypted receipt.
 *
 * Requires the /price service running (npx tsx service/server.ts) and .env creds.
 * Run: npx tsx scripts/e2e.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { issuePeriod } from "../issuer/lock.js";
import { createTopic, submitMessage, readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
import { encryptReceipt } from "../sdk/receipts.js";
import { payX402 } from "../sdk/pay.js";
import type { Receipt } from "../sdk/types.js";

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:4021/price";
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = Client.forTestnet().setOperator(
  AccountId.fromString(payerId),
  PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")),
);

console.log("== ISSUER ==");
const topicId = await createTopic(client, "notyet-e2e");
console.log("HCS topic:", topicId);

const now = Date.now();
const rounds = [roundForTime(now + 12_000), roundForTime(now + 600_000)]; // p0 soon, p1 far
const master = newMasterViewSecret();

for (let i = 0; i < rounds.length; i++) {
  const p = await issuePeriod(client, { index: i, round: rounds[i], budgetTinybars: "50000000" }); // 0.5 HBAR
  await submitMessage(client, topicId, JSON.stringify({ index: p.index, round: p.round, accountId: p.accountId, ciphertext: p.ciphertext }));
  console.log(`  period ${i}: account ${p.accountId}, round ${p.round}, key locked -> HCS`);
}

console.log("\n== AGENT ==");
await sleep(6000); // let mirror index the topic
const msgs = await readMessages(topicId);
const periods = msgs.map((m) => JSON.parse(m.contents) as { index: number; round: number; accountId: string; ciphertext: string });
console.log(`read ${periods.length} locked periods from HCS`);

// Try period 1 early — must be NOT_YET.
try {
  await decryptCiphertext(periods[1].ciphertext);
  console.log("UNEXPECTED: period 1 decrypted early");
} catch (err) {
  console.log(`period 1 →`, isNotYet(err) ? "NOT_YET (key does not exist yet)" : (err as Error).message);
}

// Unlock period 0 on its round.
const p0 = periods[0];
const waitMs = Math.max(0, roundUnlockMs(p0.round) - Date.now()) + 4000;
console.log(`waiting ${Math.round(waitMs / 1000)}s for period 0's round…`);
await sleep(waitMs);
const spendKey = (await decryptCiphertext(p0.ciphertext)).toString("utf8");
console.log("period 0 unlocked — paying from", p0.accountId);

const result = await payX402(SERVICE_URL, { accountId: p0.accountId, privateKey: spendKey });
console.log("paid:", result.paid, "| data:", JSON.stringify(result.data));
if (result.hashscan) console.log("HashScan:", result.hashscan);

// Log an encrypted receipt for period 0.
const receipt: Receipt = { periodIndex: 0, service: "price", amount: "100000", timestampMs: Date.now(), resultHash: "demo" };
const seq = await submitMessage(client, topicId, encryptReceipt(receipt, deriveViewKey(master, 0)));
console.log(`encrypted receipt -> HCS (seq ${seq})`);

client.close();
console.log("\nE2E OK");
process.exit(result.paid ? 0 : 1);
