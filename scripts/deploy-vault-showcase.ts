/**
 * Deploy a PERSISTENT PeriodVault on Hedera testnet with a committed example schedule, so
 * the site can link to a live, inspectable contract. Approver = the real Ledger issuer key
 * (the same address shown in the Proof section). Prints ids to put in .env / the UI.
 *
 * Run once: npx tsx scripts/deploy-vault-showcase.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { deployVault, commitPeriod, deposit, evmAddressOf } from "../sdk/vault.js";

const ISSUER_EVM = "0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D"; // the Ledger issuer (approver)
const tb = (h: number) => BigInt(Math.round(h * 1e8));

const client = Client.forTestnet()
  .setOperator(
    AccountId.fromString(process.env.HEDERA_PAYER_ID!),
    PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")),
  )
  .setDefaultMaxTransactionFee(new Hbar(20));

const now = () => Math.floor(Date.now() / 1000);

// no-alias recipient (contract .call{value} can't credit an aliased account)
const rk = PrivateKey.generateECDSA();
const rid = (await (await new AccountCreateTransaction().setKeyWithoutAlias(rk.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(client)).getReceipt(client)).accountId!.toString();
const agentEvm = "0x" + AccountId.fromString(rid).toSolidityAddress();
console.log("recipient (no-alias):", rid);

const { contractId, contractEvm } = await deployVault(client, { agentEvm, approverEvm: ISSUER_EVM, initialTinybar: 0 });
console.log("vault:", contractId, contractEvm);
await deposit(client, contractId, 100_000_000); // 1 HBAR of demo liquidity
console.log("deposited 1 HBAR");

// a small example schedule: 3 daily periods, $5-ish each, first open now
const periods = [
  { i: 0, budget: 0.05, perTxMax: 0.02, from: now() - 60, dur: 86400 },
  { i: 1, budget: 0.05, perTxMax: 0.02, from: now() + 86400, dur: 86400 },
  { i: 2, budget: 0.05, perTxMax: 0.02, from: now() + 172800, dur: 86400 },
];
for (const p of periods) {
  const k = generatePrivateKey();
  const st = await commitPeriod(client, contractId, {
    i: p.i, signerEvm: evmAddressOf(k), budgetTinybar: tb(p.budget), start: p.from, end: p.from + p.dur, perTxMaxTinybar: tb(p.perTxMax),
  });
  console.log(`committed period ${p.i}: budget ${p.budget} HBAR, opens ${new Date(p.from * 1000).toISOString()} — ${st}`);
}

console.log("\n=== add to .env / Railway ===");
console.log("VAULT_CONTRACT_ID=" + contractId);
console.log("VAULT_CONTRACT_EVM=" + contractEvm);
console.log("VAULT_RECIPIENT_ID=" + rid);
console.log("HashScan:", `https://hashscan.io/testnet/contract/${contractId}`);
client.close();
