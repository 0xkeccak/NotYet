/**
 * One-time setup for the vault-backed live demo:
 *   - create a no-alias agent account (receives withdrawals, pays x402 from them)
 *   - deploy a persistent PeriodVault(agent, approver = Ledger issuer)
 *   - deposit demo liquidity
 * Writes DEMO_VAULT_ID / DEMO_VAULT_EVM / DEMO_AGENT_ID / DEMO_AGENT_KEY / DEMO_AGENT_EVM
 * to .env (key kept local + gitignored). Add the same to Railway.
 *
 * Run: npx tsx scripts/setup-vault-demo.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { deployVault, deposit } from "../sdk/vault.js";

const ISSUER_EVM = "0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D"; // Ledger issuer = approver
const LIQUIDITY_TINYBAR = 500_000_000; // 5 HBAR of demo liquidity

const client = Client.forTestnet()
  .setOperator(
    AccountId.fromString(process.env.HEDERA_PAYER_ID!),
    PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")),
  )
  .setDefaultMaxTransactionFee(new Hbar(20));

// no-alias ECDSA agent account (same shape issuePeriod uses; payX402 works with it)
const agentKey = PrivateKey.generateECDSA();
const agentId = (await (await new AccountCreateTransaction().setKeyWithoutAlias(agentKey.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(client)).getReceipt(client)).accountId!.toString();
const agentEvm = "0x" + AccountId.fromString(agentId).toSolidityAddress();
console.log("agent account:", agentId);

const { contractId, contractEvm } = await deployVault(client, { agentEvm, approverEvm: ISSUER_EVM, initialTinybar: 0 });
console.log("vault:", contractId, contractEvm);
await deposit(client, contractId, LIQUIDITY_TINYBAR);
console.log(`deposited ${LIQUIDITY_TINYBAR / 1e8} HBAR liquidity`);
client.close();

// persist to .env (replace or append)
let env = readFileSync(".env", "utf8");
const set = (k: string, v: string) => {
  env = new RegExp("^" + k + "=", "m").test(env) ? env.replace(new RegExp("^" + k + "=.*", "m"), `${k}=${v}`) : env + `\n${k}=${v}`;
};
set("DEMO_VAULT_ID", contractId);
set("DEMO_VAULT_EVM", contractEvm);
set("DEMO_AGENT_ID", agentId);
set("DEMO_AGENT_KEY", agentKey.toStringRaw());
set("DEMO_AGENT_EVM", agentEvm);
writeFileSync(".env", env);

console.log("\n✓ written to .env (DEMO_AGENT_KEY kept local). Mirror these to Railway:");
console.log("  DEMO_VAULT_ID=" + contractId);
console.log("  DEMO_VAULT_EVM=" + contractEvm);
console.log("  DEMO_AGENT_ID=" + agentId);
console.log("  DEMO_AGENT_EVM=" + agentEvm);
console.log("  DEMO_AGENT_KEY=(in .env, not printed)");
console.log("HashScan:", `https://hashscan.io/testnet/contract/${contractId}`);
