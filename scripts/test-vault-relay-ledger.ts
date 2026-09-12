/**
 * Ledger-as-owner gate: the vault is deployed AND governed by the device.
 *
 * Deploys PeriodVault through the Hedera JSON-RPC relay with the transaction SIGNED ON THE
 * LEDGER, then commits a period the same way — proving the on-chain `owner` (and `approver`)
 * is one device identity. Collapses the 3-role model to 2 (Ledger = owner+approver, + agent).
 *
 *   fund the Ledger EVM address [native, one-time] → deploy(signed on Ledger)
 *     → assert owner()==approver()==Ledger → commitPeriod(signed on Ledger) → read it back
 *
 * Prereq: `bash scripts/speculos-up.sh` with **blind signing enabled** on the device
 * (contract txs have no clear-sign descriptor; the app rejects them 0x6a80 otherwise), and a
 * funded native payer. Run: npx tsx scripts/test-vault-relay-ledger.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId, Hbar, TransferTransaction, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { getAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { VAULT_ARTIFACT, evmAddressOf } from "../sdk/vault.js";
import { hederaRelayClient, deployVaultViaRelay, commitPeriodViaRelay } from "../sdk/vault-relay.js";
import { ledgerIssuerAddress } from "../issuer/ledger.js";

const now = () => Math.floor(Date.now() / 1000);
const tb = (h: number) => BigInt(Math.round(h * 1e8));
const pub = hederaRelayClient();

const ledger = getAddress(await ledgerIssuerAddress());
console.log("Ledger owner-to-be:", ledger);

const native = Client.forTestnet()
  .setOperator(AccountId.fromString(process.env.HEDERA_PAYER_ID!), PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")))
  .setDefaultMaxTransactionFee(new Hbar(20));

// 1 — fund the Ledger address so it can pay relay gas (auto-creates a hollow account)
let bal = await pub.getBalance({ address: ledger });
if (bal < 8n * 10n ** 18n) {
  console.log("  funding the Ledger address with 40 HBAR…");
  await (await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(process.env.HEDERA_PAYER_ID!), new Hbar(-40))
    .addHbarTransfer(AccountId.fromEvmAddress(0, 0, ledger), new Hbar(40))
    .execute(native)).getReceipt(native);
  for (let i = 0; i < 12 && bal < 8n * 10n ** 18n; i++) { await new Promise((r) => setTimeout(r, 2000)); bal = await pub.getBalance({ address: ledger }); }
}
console.log("  Ledger balance (weibar):", bal.toString());

// a no-alias recipient (so the vault's .call{value} can credit it later)
const recKey = PrivateKey.generateECDSA();
const recId = (await (await new AccountCreateTransaction().setKeyWithoutAlias(recKey.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(native)).getReceipt(native)).accountId!.toString();
const agentEvm = getAddress("0x" + AccountId.fromString(recId).toSolidityAddress());
native.close();

let pass = 0, fail = 0;
const check = (label: string, ok: boolean) => { console.log(`  ${ok ? "✓" : "✗"} ${label}`); ok ? pass++ : fail++; };

// 2 — DEPLOY, signed on the Ledger
console.log("\ndeploying the vault — signing on the Ledger (DMK)…");
const { contractEvm } = await deployVaultViaRelay(pub, { ownerEvm: ledger, agentEvm, approverEvm: ledger });
console.log("  vault:", contractEvm);
const owner = getAddress(await pub.readContract({ address: contractEvm, abi: VAULT_ARTIFACT.abi as any, functionName: "owner" }) as `0x${string}`);
const approver = getAddress(await pub.readContract({ address: contractEvm, abi: VAULT_ARTIFACT.abi as any, functionName: "approver" }) as `0x${string}`);
check("owner() == Ledger", owner === ledger);
check("approver() == Ledger", approver === ledger);

// 3 — COMMIT a period, signed on the Ledger (owner-only op), then read it back
console.log("\ncommitting period 0 — signing on the Ledger…");
const k0 = generatePrivateKey();
const start = now() - 30, end = now() + 3600;
await commitPeriodViaRelay(pub, contractEvm, ledger, { i: 0, signerEvm: evmAddressOf(k0), budgetTinybar: tb(0.05), start, end, perTxMaxTinybar: tb(0.02) });
const p = await pub.readContract({ address: contractEvm, abi: VAULT_ARTIFACT.abi as any, functionName: "periods", args: [0n] }) as any[];
check("committed period.signer == address(k0)", getAddress(p[0]) === getAddress(evmAddressOf(k0)));
check("committed period.budget == 0.05 HBAR", BigInt(p[1]) === tb(0.05));

console.log(`\n${fail === 0 ? "✓ LEDGER-OWNS-VAULT PASS" : "✗ FAIL"} — owner + approver are one device identity; deploy & commit both signed on the Ledger`);
console.log(`vault: https://hashscan.io/testnet/contract/${contractEvm}`);
process.exit(fail === 0 ? 0 : 1);
