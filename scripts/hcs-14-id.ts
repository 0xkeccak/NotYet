/**
 * Print the NotYet agent's HCS-14 Universal Agent ID (deterministic, offline).
 * The nativeId anchors it to the agent's Hedera account (CAIP-10). Publish the profile
 * to an HCS-11 topic separately (needs HBAR); this just derives the stable identifier.
 *
 * Run: npx tsx scripts/hcs-14-id.ts
 */
import "dotenv/config";
import { agentUaid, type AgentMetadata } from "../sdk/hcs14.js";

const network = process.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";
const account = process.env.HEDERA_AGENT_ID ?? process.env.HEDERA_MERCHANT_ID ?? "0.0.0";

const meta: AgentMetadata = {
  name: "notyet-agent",
  version: "0.1.0",
  protocol: "mcp",
  nativeId: `hedera:${network}:${account}`,
  skills: ["notyet_status", "notyet_pay"],
};

const uaid = agentUaid(meta, { uid: "0" });
console.log("HCS-14 agent metadata:", JSON.stringify(meta));
console.log("UAID:", uaid);
