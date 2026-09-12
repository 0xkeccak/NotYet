/**
 * PeriodVault — the **Ledger-as-owner** path.
 *
 * The native client (`sdk/vault.ts`) deploys/commits with an ordinary Hedera account, then
 * uses the Ledger only as the ecrecover `approver`. This module instead submits the
 * owner-only operations (deploy, commitPeriod, reclaim) through the Hedera **JSON-RPC relay**
 * as ordinary Ethereum transactions **signed on the Ledger** — so the on-chain `owner` and
 * `approver` are the *same device identity*. Funding stays permissionless (anyone can
 * `deposit`), and the agent still withdraws via the native path.
 *
 * Requires: the Ledger EVM address funded with HBAR (to pay relay gas), and **blind signing
 * enabled** on the device — contract-creation / contract-call transactions have no clear-sign
 * descriptor, so the app rejects them (0x6a80) unless blind signing is on. See LEDGER_FEEDBACK.md.
 */
import { createPublicClient, http, defineChain, serializeTransaction, encodeAbiParameters, encodeFunctionData, getAddress, type PublicClient } from "viem";
import { VAULT_ARTIFACT } from "./vault.js";
import { signTxWithLedger } from "../issuer/ledger.js";
import type { LedgerOptions } from "../issuer/ledger.js";

export const HEDERA_RELAY_URL = process.env.HEDERA_RELAY_URL ?? "https://testnet.hashio.io/api";

/** A viem public client pointed at the Hedera testnet EVM relay (chain 296). */
export function hederaRelayClient(url: string = HEDERA_RELAY_URL): PublicClient {
  const chain = defineChain({
    id: 296,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  return createPublicClient({ chain, transport: http(url) });
}

/** Build a legacy tx, sign it on the Ledger, broadcast via the relay, wait for the receipt. */
async function sendLedgerTx(
  pub: PublicClient,
  from: `0x${string}`,
  tx: { to?: `0x${string}`; data?: `0x${string}`; value?: bigint },
  opts?: LedgerOptions,
) {
  const nonce = await pub.getTransactionCount({ address: from });
  const gasPrice = await pub.getGasPrice();
  const req = { to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: 4_000_000n, gasPrice, nonce, chainId: 296 as const, type: "legacy" as const };
  const { r, s, v } = await signTxWithLedger(serializeTransaction(req), opts);
  const serializedTransaction = serializeTransaction(req, { r, s, v: BigInt(v) });
  const hash = await pub.sendRawTransaction({ serializedTransaction });
  return pub.waitForTransactionReceipt({ hash });
}

/** Deploy PeriodVault(agent, approver) with the Ledger as the transaction signer → owner. */
export async function deployVaultViaRelay(
  pub: PublicClient,
  opts: { ownerEvm: `0x${string}`; agentEvm: `0x${string}`; approverEvm: `0x${string}`; ledger?: LedgerOptions },
): Promise<{ contractEvm: `0x${string}` }> {
  const ctorArgs = encodeAbiParameters([{ type: "address" }, { type: "address" }], [getAddress(opts.agentEvm), getAddress(opts.approverEvm)]).slice(2);
  const data = ("0x" + VAULT_ARTIFACT.bytecode + ctorArgs) as `0x${string}`;
  const rcpt = await sendLedgerTx(pub, getAddress(opts.ownerEvm), { data }, opts.ledger);
  if (!rcpt.contractAddress) throw new Error(`deploy failed: ${rcpt.status}`);
  return { contractEvm: getAddress(rcpt.contractAddress) };
}

/** Commit one period's policy (owner-only), signed on the Ledger. */
export async function commitPeriodViaRelay(
  pub: PublicClient,
  contractEvm: `0x${string}`,
  ownerEvm: `0x${string}`,
  p: { i: number; signerEvm: `0x${string}`; budgetTinybar: bigint; start: number; end: number; perTxMaxTinybar: bigint },
  ledger?: LedgerOptions,
): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: VAULT_ARTIFACT.abi as any,
    functionName: "commitPeriod",
    args: [BigInt(p.i), getAddress(p.signerEvm), p.budgetTinybar, BigInt(p.start), BigInt(p.end), p.perTxMaxTinybar],
  });
  const rcpt = await sendLedgerTx(pub, getAddress(ownerEvm), { to: contractEvm, data }, ledger);
  if (rcpt.status !== "success") throw new Error(`commitPeriod reverted for period ${p.i}`);
  return rcpt.transactionHash;
}
