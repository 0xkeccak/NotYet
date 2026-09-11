/**
 * Day-1 gate for the PeriodVault redesign. Proves, live on Hedera testnet, that spend
 * authority is gated by the contract exactly as claimed:
 *
 *   deploy → deposit → in-window withdraw SUCCEEDS
 *          → future-window withdraw REVERTS  (outside window)
 *          → over-budget withdraw REVERTS    (budget cap)
 *          → over-perTxMax without approver REVERTS, with approver SUCCEEDS (HITL)
 *
 * Needs a funded payer (~3 HBAR: contract create + 0.5 HBAR initial balance). The approver
 * here is a software key standing in for the Ledger issuer key (same ecrecover path).
 *
 * Run: npx tsx scripts/test-vault.ts
 */
import "dotenv/config";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { generatePrivateKey } from "viem/accounts";
import {
  deployVault,
  commitPeriod,
  deposit,
  withdraw,
  signWithdraw,
  evmAddressOf,
  HEDERA_TESTNET_CHAINID as CHAIN,
} from "../sdk/vault.js";

// amounts are tinybar (1 HBAR = 1e8) — Hedera's contract .call{value} settles in tinybar here
const tb = (h: number) => BigInt(Math.round(h * 1e8)); // HBAR → tinybar

const client = Client.forTestnet()
  .setOperator(
    AccountId.fromString(process.env.HEDERA_PAYER_ID!),
    PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")),
  )
  .setDefaultMaxTransactionFee(new Hbar(20)); // max safe: the SDK's toInt() overflows 32-bit at ~21.47 HBAR

let pass = 0;
let fail = 0;
async function expectOk(label: string, fn: () => Promise<string>) {
  try {
    const st = await fn();
    console.log(`  ✓ ${label} — ${st}`);
    pass++;
  } catch (e: any) {
    console.log(`  ✗ ${label} — expected SUCCESS but reverted: ${e.status?.toString() ?? e.message}`);
    fail++;
  }
}
async function expectRevert(label: string, needle: string, fn: () => Promise<string>) {
  try {
    await fn();
    console.log(`  ✗ ${label} — expected REVERT but it succeeded`);
    fail++;
  } catch (e: any) {
    console.log(`  ✓ ${label} — reverted as expected (${e.status?.toString() ?? "revert"})`);
    pass++;
  }
}

const now = () => Math.floor(Date.now() / 1000);

// approver = stand-in for the Ledger issuer key
const approverK = generatePrivateKey();
const approverEvm = evmAddressOf(approverK);
// Recipient must be a NO-ALIAS account: a contract's .call{value} can't cleanly credit an
// ECDSA account that has an EVM alias (via either its alias or long-zero form). Create a
// fresh account with setKeyWithoutAlias so its long-zero address is canonical and payable.
const recipientKey = PrivateKey.generateECDSA();
const recResp = await new AccountCreateTransaction().setKeyWithoutAlias(recipientKey.publicKey).setInitialBalance(Hbar.fromTinybars(0)).execute(client);
const recipientId = (await recResp.getReceipt(client)).accountId!.toString();
const agentEvm = "0x" + AccountId.fromString(recipientId).toSolidityAddress();
console.log(`agent recipient (no-alias) ${recipientId}`);

console.log("deploying PeriodVault (approver=software Ledger stand-in)…");
const { contractId, contractEvm } = await deployVault(client, { agentEvm, approverEvm, initialTinybar: 0 });
console.log(`  vault ${contractId}  (${contractEvm})`);
// Fund via the EVM payable path (deposit) so the balance is spendable inside the contract.
await deposit(client, contractId, 20_000_000); // 0.2 HBAR
console.log("  funded 0.2 HBAR via deposit()");

// period 0 — open now, budget 0.05, perTxMax 0.02
const k0 = generatePrivateKey();
await commitPeriod(client, contractId, {
  i: 0, signerEvm: evmAddressOf(k0), budgetTinybar: tb(0.05), start: now() - 30, end: now() + 3600, perTxMaxTinybar: tb(0.02),
});
// period 1 — window opens in an hour (to prove the future-window revert)
const k1 = generatePrivateKey();
await commitPeriod(client, contractId, {
  i: 1, signerEvm: evmAddressOf(k1), budgetTinybar: tb(0.05), start: now() + 3600, end: now() + 7200, perTxMaxTinybar: tb(0.02),
});
console.log("committed periods 0 (open) and 1 (future)\n");

let spent0 = 0n;
const sign = (k: string, i: number, amt: bigint, spent: bigint, tag: "agent" | "approve") =>
  signWithdraw(k, { contractEvm, chainId: CHAIN, i, amtTinybar: amt, spentTinybar: spent, tag });

console.log("running gate checks:");

// 1 — in-window, under perTxMax, valid sig → SUCCEEDS
await expectOk("in-window withdraw 0.01", async () => {
  const amt = tb(0.01);
  const st = await withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await sign(k0, 0, amt, spent0, "agent") });
  spent0 += amt;
  return st;
});

// 2 — future window → REVERTS
await expectRevert("future-window withdraw", "outside window", async () => {
  const amt = tb(0.01);
  return withdraw(client, contractId, { i: 1, amtTinybar: amt, agent: await sign(k1, 1, amt, 0n, "agent") });
});

// 3 — over remaining budget (0.05 total, 0.01 spent) → REVERTS
await expectRevert("over-budget withdraw 0.05", "budget", async () => {
  const amt = tb(0.05);
  return withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await sign(k0, 0, amt, spent0, "agent") });
});

// 4a — over perTxMax (0.02) with agent sig only → REVERTS (needs device approval)
await expectRevert("over-perTxMax without approver", "needs device approval", async () => {
  const amt = tb(0.03);
  return withdraw(client, contractId, { i: 0, amtTinybar: amt, agent: await sign(k0, 0, amt, spent0, "agent") });
});

// 4b — same amount WITH approver co-sign → SUCCEEDS (human-in-the-loop)
await expectOk("over-perTxMax with approver", async () => {
  const amt = tb(0.03);
  const st = await withdraw(client, contractId, {
    i: 0, amtTinybar: amt,
    agent: await sign(k0, 0, amt, spent0, "agent"),
    approver: await sign(approverK, 0, amt, spent0, "approve"),
  });
  spent0 += amt;
  return st;
});

console.log(`\n${fail === 0 ? "✓ GATE PASS" : "✗ GATE FAIL"} — ${pass} passed, ${fail} failed`);
console.log(`vault on HashScan: https://hashscan.io/testnet/contract/${contractId}`);
client.close();
process.exit(fail === 0 ? 0 : 1);
