/**
 * Prove the HIP-423 sign-on-unlock path against Hedera testnet:
 *   create pending schedule → sign early throws NOT_YET → after the round, sign executes.
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { issuePeriod } from "../issuer/lock.js";
import { decryptCiphertext, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { createScheduledTransfer, signScheduled, scheduleStatus } from "../sdk/scheduled.js";

const c = Client.forTestnet().setOperator(
  AccountId.fromString(process.env.HEDERA_PAYER_ID!),
  PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")),
);
const merchant = process.env.HEDERA_MERCHANT_ID!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEC = 12;
const round = roundForTime(Date.now() + SEC * 1000);
console.log(`issuing a period funded 0.03ℏ, key timelocked to round ${round} (~${SEC}s)…`);
const p = await issuePeriod(c, { index: 0, round, budgetTinybars: "3000000" });
console.log(`  account ${p.accountId}`);

const { scheduleId, scheduledTxId } = await createScheduledTransfer(c, {
  fromAccountId: p.accountId,
  toAccountId: merchant,
  tinybars: 2_000_000,
  expirationSec: SEC + 300,
});
console.log(`  pending schedule ${scheduleId}, will execute as tx ${scheduledTxId}`);

console.log("\ntrying to sign EARLY (expect NOT_YET)…");
try {
  const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
  await signScheduled(c, scheduleId, key);
  console.log("  ✗ UNEXPECTED: signed early");
} catch (e) {
  console.log(isNotYet(e) ? "  ✓ NOT_YET — the signing key does not exist yet" : `  ✗ wrong error: ${(e as Error).message}`);
}

console.log(`\nwaiting for round ${round}…`);
while (Date.now() < roundUnlockMs(round) + 3000) await sleep(1500);

console.log("signing now (expect execution)…");
const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
const status = await signScheduled(c, scheduleId, key);
console.log(`  ScheduleSign status: ${status}`);

await sleep(6000); // let the mirror node index it
const st = await scheduleStatus(scheduleId);
console.log(`  mirror: executed=${st.executed} at=${st.executedTimestamp ?? "-"}`);
console.log(st.executed ? "\n✓ PASS — scheduled transfer executed only after its round" : "\n✗ mirror not yet showing execution (may lag)");
c.close();
