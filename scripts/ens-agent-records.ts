/**
 * Publish ENSIP-26 agent records to the Notyet agent's ENS name, making the name its
 * discoverable identity: what it is, and how to reach it (web + a2a x402 endpoint + mcp).
 * Optionally attest ENSIP-25 registry membership.
 *
 * Run: npx tsx scripts/ens-agent-records.ts   (reads .env: SEPOLIA_RPC_URL, ENS_OWNER_KEY, ENS_NAME)
 */
import "dotenv/config";
import { publishAgentRecords, readAgentRecords } from "../sdk/ens.js";

const rpc = process.env.SEPOLIA_RPC_URL!;
const ownerKey = process.env.ENS_OWNER_KEY as `0x${string}`;
const name = process.env.ENS_NAME ?? "mujahid.eth";
const base = process.env.PUBLIC_URL ?? "https://notyet.up.railway.app";

const context = [
  "# Notyet agent",
  "Scheduled agent spend authority: each period's spend key is timelock-encrypted (drand/tlock)",
  "and does not exist before its round. Pays x402 services on Hedera within a per-period budget.",
  `Web: ${base} · A2A (x402 pay endpoint): ${base}/price`,
].join("\n");

console.log(`publishing ENSIP-26 agent records to ${name} …`);
const txs = await publishAgentRecords(rpc, ownerKey, name, {
  context,
  endpoints: { web: base, a2a: `${base}/price`, mcp: `${base}/mcp` },
});
console.log("txs:", txs.join(", "));

await new Promise((r) => setTimeout(r, 6000)); // let the resolver settle
const back = await readAgentRecords(rpc, name);
console.log("read back:", JSON.stringify(back, null, 2));
