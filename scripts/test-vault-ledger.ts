/**
 * #2 gate — the over-cap co-sign is a REAL Ledger tap, proven on Hedera testnet.
 *
 * Unlike scripts/test-vault.ts (software stand-in approver), this deploys the vault with
 * the **Ledger device address** as approver and drives the over-perTxMax withdrawal with a
 * signature produced on the (Speculos-emulated) device:
 *
 *   deploy(approver = Ledger)  → deposit
 *     → in-cap withdraw           SUCCEEDS  (agent alone, autonomous)
 *     → over-cap, agent only      REVERTS   ("needs device approval")
 *     → over-cap + Ledger co-sign SUCCEEDS  (human-in-the-loop, on-device)
 *
 * Prereq: `bash scripts/speculos-up.sh` + a funded payer. Run: npx tsx scripts/test-vault-ledger.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import { deployVault, commitPeriod, deposit, withdraw, signWithdraw, evmAddressOf, HEDERA_TESTNET_CHAINID as CHAIN } from "../sdk/vault.js";
import { ledgerIssuerAddress, ledgerApproveWithdraw } from "../issuer/ledger.js";

const tb = (h: number) => BigInt(Math.round(h * 1e8));
const now = () => Math.floor(Date.now() / 1000);
const client = Client.forTestnet()
  .setOperator(AccountId.fromString(process.env.HEDERA_PAYER_ID!), PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")))
  .setDefaultMaxTransactionFee(new Hbar(20));

let pass = 0, fail = 0;
const ok = async (label: string, fn: () => Promise<string>) => {
  try { console.log(`  ✓ ${label} — ${await fn()}`); pass++; } catch (e: any) { console.log(`  ✗ ${label} — expected SUCCESS, reverted: ${e.status?.toString() ?? e.message}`); fail++; }
};
const rev = async (label: string, fn: () => Promise<string>) => {
  try { await fn(); console.log(`  ✗ ${label} — expected REVERT but succeeded`); fail++; } catch (e: any) { console.log(`  ✓ ${label} — reverted (${e.status?.toString() ?? "revert"})`); pass++; }
};

const approverEvm = await ledgerIssuerAddress();
console.log(`approver = Ledger device (DMK/Speculos): ${approverEvm}`);

const recipientKey = PrivateKey.generateECDSA();
const recipientId = (await (await new AccountCreateTransaction().setKeyWithoutAlias(recipientKey.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(client)).getReceipt(client)).accountId!.toString();
const agentEvm = "0x" + AccountId.fromString(recipientId).toSolidityAddress();

const { contractId, contractEvm } = await deployVault(client, { agentEvm, approverEvm, initialTinybar: 0 });
await deposit(client, contractId, 20_000_000);
console.log(`vault ${contractId} funded 0.2 HBAR, agent ${recipientId}\n`);

const k0 = generatePrivateKey();
await commitPeriod(client, contractId, { i: 0, signerEvm: evmAddressOf(k0), budgetTinybar: tb(0.08), start: now() - 30, end: now() + 3600, perTxMaxTinybar: tb(0.02) });
console.log("committed period 0 (budget 0.08, perTxMax 0.02)\n");

let spent = 0n;
const agentSig = (amt: bigint) => signWithdraw(k0, { contractEvm, chainId: CHAIN, i: 0, amtTinybar: amt, spentTinybar: spent, tag: "agent" });

console.log("gate checks:");
await ok("in-cap withdraw 0.01 (agent alone)", async () => {
  const amt = tb(0.01); const st = await withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await agentSig(amt) }); spent += amt; return st;
});
await rev("over-cap 0.03 without device", async () => {
  const amt = tb(0.03); return withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await agentSig(amt) });
});
await ok("over-cap 0.03 WITH Ledger co-sign", async () => {
  const amt = tb(0.03);
  console.log("    → requesting on-device approval (Ledger tap)…");
  const approver = await ledgerApproveWithdraw({ contractEvm, chainId: CHAIN, i: 0, amtTinybar: amt, spentTinybar: spent });
  const st = await withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await agentSig(amt), approver }); spent += amt; return st;
});

console.log(`\n${fail === 0 ? "✓ LEDGER GATE PASS" : "✗ LEDGER GATE FAIL"} — ${pass} passed, ${fail} failed`);
console.log(`vault: https://hashscan.io/testnet/contract/${contractId}`);
client.close();
process.exit(fail === 0 ? 0 : 1);
