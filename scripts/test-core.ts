/**
 * Fast, offline sanity checks for the pure core (schedule + derivation).
 * No network, no keys. Run: npx tsx scripts/test-core.ts
 */
import { buildSchedule, currentPeriodIndex, canonicalJSON } from "../issuer/schedule.js";
import { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
import { roundUnlockMs } from "../sdk/tlock.js";
import { signSchedule, verifySchedule, issuerAddress } from "../sdk/sign.js";
import { encryptReceipt, decryptReceipt } from "../sdk/receipts.js";
import { generatePrivateKey } from "viem/accounts";
import type { Receipt } from "../sdk/types.js";

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
};

const PERIOD_SEC = 120;
const start = 1_760_000_000_000; // fixed ms so the test is deterministic
const schedule = buildSchedule({
  agentId: "notyet-demo",
  network: "hedera:testnet",
  asset: "0.0.0",
  issuerPubKey: "0xISSUER",
  periodCount: 5,
  periodLengthSec: PERIOD_SEC,
  startMs: start,
  budget: "1000000", // 0.01 HBAR-ish smallest units
});

check("5 periods built", schedule.periods.length === 5);
check("period rounds strictly increase", schedule.periods.every((p, i) => i === 0 || p.round > schedule.periods[i - 1].round));
check("round unlock ~ period start (±1 round)", schedule.periods.every((p) => Math.abs(roundUnlockMs(p.round) - p.startMs) <= 3000));

check("before start → -1", currentPeriodIndex(schedule, start - 1000, PERIOD_SEC) === -1);
check("mid period 0", currentPeriodIndex(schedule, start + 1000, PERIOD_SEC) === 0);
check("mid period 3", currentPeriodIndex(schedule, start + 3 * PERIOD_SEC * 1000 + 1000, PERIOD_SEC) === 3);
check("after last → -1", currentPeriodIndex(schedule, start + 5 * PERIOD_SEC * 1000 + 1000, PERIOD_SEC) === -1);

check("canonicalJSON stable across key order", canonicalJSON(schedule) === canonicalJSON(JSON.parse(JSON.stringify(schedule))));
check("canonicalJSON keeps nested period keys", canonicalJSON(schedule).includes('"round":') && canonicalJSON(schedule).includes('"startMs":'));

const master = newMasterViewSecret();
const v3a = deriveViewKey(master, 3);
const v3b = deriveViewKey(master, 3);
const v4 = deriveViewKey(master, 4);
check("view key deterministic", v3a.equals(v3b));
check("view keys differ per period", !v3a.equals(v4));
check("view key is 32 bytes", v3a.length === 32);

// --- schedule signing / verification (ENS root of trust) ---
const issuerKey = generatePrivateKey();
const signedSchedule = buildSchedule({
  agentId: "notyet-demo",
  network: "hedera:testnet",
  asset: "0.0.0",
  issuerPubKey: issuerAddress(issuerKey),
  periodCount: 3,
  periodLengthSec: PERIOD_SEC,
  startMs: start,
  budget: "1000000",
});
const signed = await signSchedule(signedSchedule, issuerKey);
check("valid signature verifies", await verifySchedule(signed));

const tampered = { ...signed, schedule: { ...signed.schedule, periods: signed.schedule.periods.slice(0, 2) } };
check("tampered schedule fails verify", !(await verifySchedule(tampered)));

const wrongIssuer = { ...signed, schedule: { ...signed.schedule, issuerPubKey: issuerAddress(generatePrivateKey()) } };
check("wrong issuer fails verify", !(await verifySchedule(wrongIssuer)));

// --- scoped-audit receipts ---
const receipt: Receipt = { periodIndex: 3, service: "price", amount: "100000", timestampMs: start, resultHash: "0xabc" };
const v3 = deriveViewKey(master, 3);
const enc = encryptReceipt(receipt, v3);
check("receipt decrypts with its view key", JSON.stringify(decryptReceipt(enc, v3)) === JSON.stringify(receipt));
let scoped = false;
try {
  decryptReceipt(enc, deriveViewKey(master, 4));
} catch {
  scoped = true;
}
check("receipt is NOT readable with another period's key (scoped audit)", scoped);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
