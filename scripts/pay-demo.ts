/**
 * Gate #2b — full x402 handshake. Pay the running /price service with the payer key
 * via the Blocky402 facilitator. (Assumes `service/server.ts` is already listening.)
 * Run: npx tsx scripts/pay-demo.ts
 */
import "dotenv/config";
import { payX402 } from "../sdk/pay.js";

const URL = process.env.SERVICE_URL ?? "http://localhost:4021/price";
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
const network = process.env.HEDERA_NETWORK === "mainnet" ? "hedera:mainnet" : "hedera:testnet";

if (!payerId || !payerKey) throw new Error("HEDERA_PAYER_ID / HEDERA_PAYER_KEY missing");

console.log(`paying ${URL} as ${payerId} …`);
const result = await payX402(URL, { accountId: payerId, privateKey: payerKey, network });

console.log("paid:", result.paid, "status:", result.status);
console.log("data:", JSON.stringify(result.data));
if (result.settlement) {
  console.log("settlement tx:", result.settlement);
  console.log("HashScan:", result.hashscan);
} else {
  console.log("no settlement tx returned");
}
process.exit(result.paid ? 0 : 1);
