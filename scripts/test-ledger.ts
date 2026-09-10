/**
 * Capstone: the issuer key on the (emulated) Ledger (DMK) signs the schedule; it's
 * published to Hedera (HCS); the agent resolves and verifies it against the trusted
 * issuer. Ties Ledger + Hedera together.
 * Requires Speculos running (see scripts/speculos-up.sh) and .env.
 * Run: npx tsx scripts/test-ledger.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { buildSchedule } from "../issuer/schedule.js";
import { verifySchedule } from "../sdk/sign.js";
import { ledgerIssuerAddress, signScheduleWithLedger } from "../issuer/ledger.js";
import { createTopic } from "../sdk/hcs.js";
import { publishSchedule } from "../issuer/publish.js";
import { resolveSchedule } from "../agent/resolve.js";

const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
const agentId = process.env.AGENT_ID ?? "notyet-demo";
const hedera = () => Client.forTestnet().setOperator(AccountId.fromString(payerId), PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")));

const issuer = await ledgerIssuerAddress();
console.log("Ledger (DMK/Speculos) issuer address:", issuer);

const c = hedera();
const topicId = await createTopic(c, "notyet-ledger");
console.log("HCS topic:", topicId);

const schedule = buildSchedule({
  agentId,
  network: "hedera:testnet",
  asset: "0.0.0",
  issuerPubKey: issuer,
  periodCount: 3,
  periodLengthSec: 90,
  budget: "50000000",
  hcsTopicId: topicId,
});

console.log("signing schedule on the emulated Ledger via DMK (auto-confirming the device prompt)…");
const signed = await signScheduleWithLedger(schedule);
console.log("offline verify:", (await verifySchedule(signed)) ? "PASS" : "FAIL");

console.log("publishing Ledger-signed schedule to HCS…");
const seq = await publishSchedule(c, topicId, signed);
console.log("  schedule on HCS, seq:", seq);
c.close();

// The mirror node lags a few seconds after consensus; let it index.
await new Promise((r) => setTimeout(r, 6000));
const resolved = await resolveSchedule(topicId, issuer);
console.log(`PASS: agent resolved + verified a Ledger-signed schedule (${resolved.periods.length} periods) from HCS topic ${topicId}`);
console.log("trusted issuer == Ledger address:", resolved.issuerPubKey.toLowerCase() === issuer.toLowerCase());
