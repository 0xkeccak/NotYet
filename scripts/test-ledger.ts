/**
 * Capstone: the issuer key on the (emulated) Ledger signs the schedule; it's published
 * to ENS; the agent resolves and verifies it. Ties Ledger + ENS together.
 * Requires Speculos running (see scripts/speculos-up.sh) and .env.
 * Run: npx tsx scripts/test-ledger.ts
 */
import "dotenv/config";
import { buildSchedule } from "../issuer/schedule.js";
import { verifySchedule } from "../sdk/sign.js";
import { ledgerIssuerAddress, signScheduleWithLedger } from "../issuer/ledger.js";
import { publishSchedule } from "../issuer/publish.js";
import { resolveSchedule } from "../agent/resolve.js";

const rpc = process.env.SEPOLIA_RPC_URL!;
const ownerKey = process.env.ENS_OWNER_KEY as `0x${string}`;
const ensName = process.env.ENS_NAME ?? "mujahid.eth";

const issuer = await ledgerIssuerAddress();
console.log("Ledger (Speculos) issuer address:", issuer);

const schedule = buildSchedule({
  ensName,
  network: "hedera:testnet",
  asset: "0.0.0",
  issuerPubKey: issuer,
  periodCount: 3,
  periodLengthSec: 90,
  budget: "50000000",
});

console.log("signing schedule on the emulated Ledger (auto-confirming the device prompt)…");
const signed = await signScheduleWithLedger(schedule);
console.log("offline verify:", (await verifySchedule(signed)) ? "PASS" : "FAIL");

console.log("publishing Ledger-signed schedule to", ensName, "…");
const { issuerTx, scheduleTx } = await publishSchedule(rpc, ownerKey, ensName, signed);
console.log("  issuer record tx:", issuerTx);
console.log("  schedule record tx:", scheduleTx);

// The public RPC lags a few seconds after a write; let the records settle before reading.
await new Promise((r) => setTimeout(r, 6000));
const resolved = await resolveSchedule(rpc, ensName);
console.log(`PASS: agent resolved + verified a Ledger-signed schedule (${resolved.periods.length} periods) from ${ensName}`);
console.log("issuer on ENS == Ledger address:", resolved.issuerPubKey.toLowerCase() === issuer.toLowerCase());
