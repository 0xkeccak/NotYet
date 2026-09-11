/**
 * PeriodVault client — deploy the contract, commit periods, deposit, and drive
 * timelock-gated withdrawals on Hedera testnet via @hiero-ledger/sdk (no ethers).
 *
 * Units: amounts are TINYBAR (1 HBAR = 1e8). Empirically Hederas .call{value} here settles
 * in tinybar, so budgets / amounts / perTxMax / spent are all tinybar bigints.
 */
import {
  Client,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
} from "@hiero-ledger/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, encodePacked, hexToBytes, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** EVM address of a raw ECDSA private key (hex, with or without 0x). */
export function evmAddressOf(kHex: string): `0x${string}` {
  return privateKeyToAccount(with0x(kHex)).address;
}

export const HEDERA_TESTNET_CHAINID = 296;

const artifactPath = fileURLToPath(new URL("../contracts/PeriodVault.json", import.meta.url));
export const VAULT_ARTIFACT = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown[]; bytecode: string };

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);
// ContractFunctionParameters.addUint256 accepts a decimal string at runtime; the SDK's
// typings only name number|BigNumber|Long, so pass the string through as-is.
const u256 = (v: bigint | number | string): any => v.toString();
const with0x = (h: string): `0x${string}` => (h.startsWith("0x") ? (h as `0x${string}`) : (`0x${h}` as const));

/** Deploy PeriodVault(agent, approver) with an initial HBAR balance. */
export async function deployVault(
  client: Client,
  opts: { agentEvm: string; approverEvm: string; initialTinybar: number },
): Promise<{ contractId: string; contractEvm: string }> {
  // Inline bytecode (4101 bytes fits the tx size limit) — avoids the ~2 HBAR FileCreate that
  // ContractCreateFlow charges for uploading the bytecode to a Hedera file first. With inline
  // setBytecode the SDK does NOT append setConstructorParameters, so we ABI-encode the
  // (agent, approver) args and concatenate them onto the creation bytecode ourselves.
  const args = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [with0x(opts.agentEvm), with0x(opts.approverEvm)],
  ).slice(2);
  const bytecode = Uint8Array.from(Buffer.from(VAULT_ARTIFACT.bytecode + args, "hex"));
  const resp = await new ContractCreateTransaction()
    .setBytecode(bytecode)
    .setGas(1_200_000)
    .setInitialBalance(Hbar.fromTinybars(opts.initialTinybar))
    .execute(client);
  const receipt = await resp.getReceipt(client);
  const contractId = receipt.contractId!.toString();
  return { contractId, contractEvm: "0x" + ContractId.fromString(contractId).toSolidityAddress() };
}

/** Commit one period's policy (owner only). */
export async function commitPeriod(
  client: Client,
  contractId: string,
  p: { i: number; signerEvm: string; budgetTinybar: bigint; start: number; end: number; perTxMaxTinybar: bigint },
): Promise<string> {
  const params = new ContractFunctionParameters()
    .addUint256(u256(p.i))
    .addAddress(strip0x(p.signerEvm))
    .addUint256(u256(p.budgetTinybar))
    .addUint64(p.start)
    .addUint64(p.end)
    .addUint256(u256(p.perTxMaxTinybar));
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(250_000)
    .setFunction("commitPeriod", params)
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}

/** Fund the vault with `tinybar`. */
export async function deposit(client: Client, contractId: string, tinybar: number): Promise<string> {
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(120_000)
    .setPayableAmount(Hbar.fromTinybars(tinybar))
    .setFunction("deposit")
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}

export interface WithdrawSig {
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}
const ZERO32 = ("0x" + "00".repeat(32)) as `0x${string}`;
const ZERO_SIG: WithdrawSig = { v: 27, r: ZERO32, s: ZERO32 };

/**
 * Sign a withdrawal digest with a period key `k` (raw hex). `tag` is "agent" for the
 * period key, "approve" for the approver co-sign. Mirrors the contract's digest():
 * keccak256(abi.encodePacked(contract, chainid, i, amt, spent, tag)) then EIP-191. viem's
 * signMessage({raw}) applies the exact "\x19Ethereum Signed Message:\n32" prefix the
 * contract re-derives before ecrecover.
 */
export async function signWithdraw(
  kHex: string,
  d: { contractEvm: string; chainId: number; i: number; amtTinybar: bigint; spentTinybar: bigint; tag: "agent" | "approve" },
): Promise<WithdrawSig> {
  const inner = keccak256(
    encodePacked(
      ["address", "uint256", "uint256", "uint256", "uint256", "string"],
      [with0x(d.contractEvm), BigInt(d.chainId), BigInt(d.i), d.amtTinybar, d.spentTinybar, d.tag],
    ),
  );
  const sigHex = await privateKeyToAccount(with0x(kHex)).signMessage({ message: { raw: inner } });
  return {
    v: parseInt(sigHex.slice(130, 132), 16),
    r: with0x(sigHex.slice(2, 66)),
    s: with0x(sigHex.slice(66, 130)),
  };
}

/** Withdraw `amtTinybar` for period `i`. Pass `approver` only when amt > perTxMax. */
export async function withdraw(
  client: Client,
  contractId: string,
  w: { i: number; amtTinybar: bigint; agent: WithdrawSig; approver?: WithdrawSig },
): Promise<string> {
  const a = w.agent;
  const o = w.approver ?? ZERO_SIG;
  const params = new ContractFunctionParameters()
    .addUint256(u256(w.i))
    .addUint256(u256(w.amtTinybar))
    .addUint8(a.v)
    .addBytes32(hexToBytes(a.r))
    .addBytes32(hexToBytes(a.s))
    .addUint8(o.v)
    .addBytes32(hexToBytes(o.r))
    .addBytes32(hexToBytes(o.s));
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(250_000)
    .setFunction("withdraw", params)
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}

/** Owner reclaims the unspent remainder of period `i` (only after its window ends). */
export async function reclaim(client: Client, contractId: string, i: number): Promise<string> {
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(150_000)
    .setFunction("reclaim", new ContractFunctionParameters().addUint256(u256(i)))
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}
