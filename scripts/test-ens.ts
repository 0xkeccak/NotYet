/**
 * Live ENS root-of-trust round-trip on Sepolia (ENSv2):
 *   build schedule -> sign with issuer key -> publish to ENS -> agent resolves+verifies.
 * Also proves the agent REJECTS a schedule whose signature doesn't match.
 * Run: npx tsx scripts/test-ens.ts
 */
import "dotenv/config";
import { generatePrivateKey } from "viem/accounts";
import { buildSchedule } from "../issuer/schedule.js";
import { signSchedule, issuerAddress } from "../sdk/sign.js";
import { publishSchedule } from "../issuer/publish.js";
import { resolveSchedule, UntrustedScheduleError } from "../agent/resolve.js";
import { writeText, SCHEDULE_KEY } from "../sdk/ens.js";

const rpc = process.env.SEPOLIA_RPC_URL!;
const ownerKey = process.env.ENS_OWNER_KEY as `0x${string}`;
const ensName = process.env.ENS_NAME ?? "mujahid.eth";

const issuerKey = generatePrivateKey(); // stands in for the Ledger/Speculos signer
const schedule = buildSchedule({
  ensName,
  network: "hedera:testnet",
  asset: "0.0.0",
  issuerPubKey: issuerAddress(issuerKey),
  periodCount: 3,
  periodLengthSec: 90,
  budget: "50000000",
});

console.log("issuer:", schedule.issuerPubKey);
const signed = await signSchedule(schedule, issuerKey);
console.log("publishing signed schedule to", ensName, "…");
const { issuerTx, scheduleTx } = await publishSchedule(rpc, ownerKey, ensName, signed);
console.log("issuer record tx:", issuerTx);
console.log("schedule record tx:", scheduleTx);

const resolved = await resolveSchedule(rpc, ensName);
console.log(`PASS: agent resolved + verified schedule (${resolved.periods.length} periods) from ${ensName}`);

// Tamper test: overwrite the schedule record with a mutated body; agent must reject.
const tampered = JSON.parse(JSON.stringify(signed));
tampered.schedule.periods[0].budget = "999999999";
await writeText(rpc, ownerKey, ensName, SCHEDULE_KEY, JSON.stringify(tampered));
try {
  await resolveSchedule(rpc, ensName);
  console.log("FAIL: agent accepted a tampered schedule");
  process.exit(1);
} catch (e) {
  console.log("PASS: agent REJECTED tampered schedule —", e instanceof UntrustedScheduleError ? e.message : String(e));
}

// Restore the good record.
await writeText(rpc, ownerKey, ensName, SCHEDULE_KEY, JSON.stringify(signed));
console.log("restored good schedule record");
