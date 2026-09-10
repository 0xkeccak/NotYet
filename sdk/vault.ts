/**
 * PeriodVault client — deploy the contract, commit periods, deposit, and drive
 * timelock-gated withdrawals on Hedera testnet via @hiero-ledger/sdk (no ethers).
 *
 * Units: the contract works in weibar (the EVM value unit on Hedera; 1 tinybar = 1e10
 * weibar). Budgets / amounts / perTxMax are weibar bigints here; deposits are tinybars.
 */
import {
  Client,
  ContractCreateFlow,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
} from "@hiero-ledger/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, encodePacked, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** EVM address of a raw ECDSA private key (hex, with or without 0x). */
export function evmAddressOf(kHex: string): `0x${string}` {
  return privateKeyToAccount(with0x(kHex)).address;
}

export const HEDERA_TESTNET_CHAINID = 296;
export const TINYBAR_TO_WEIBAR = 10_000_000_000n;

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
  const params = new ContractFunctionParameters().addAddress(strip0x(opts.agentEvm)).addAddress(strip0x(opts.approverEvm));
  const resp = await new ContractCreateFlow()
    .setBytecode(VAULT_ARTIFACT.bytecode)
    .setConstructorParameters(params)
    .setGas(3_000_000)
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
  p: { i: number; signerEvm: string; budgetWei: bigint; start: number; end: number; perTxMaxWei: bigint },
): Promise<string> {
  const params = new ContractFunctionParameters()
    .addUint256(u256(p.i))
    .addAddress(strip0x(p.signerEvm))
    .addUint256(u256(p.budgetWei))
    .addUint64(p.start)
    .addUint64(p.end)
    .addUint256(u256(p.perTxMaxWei));
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(1_000_000)
    .setFunction("commitPeriod", params)
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}

/** Fund the vault with `tinybar`. */
export async function deposit(client: Client, contractId: string, tinybar: number): Promise<string> {
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(200_000)
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
  d: { contractEvm: string; chainId: number; i: number; amtWei: bigint; spentWei: bigint; tag: "agent" | "approve" },
): Promise<WithdrawSig> {
  const inner = keccak256(
    encodePacked(
      ["address", "uint256", "uint256", "uint256", "uint256", "string"],
      [with0x(d.contractEvm), BigInt(d.chainId), BigInt(d.i), d.amtWei, d.spentWei, d.tag],
    ),
  );
  const sigHex = await privateKeyToAccount(with0x(kHex)).signMessage({ message: { raw: inner } });
  return {
    v: parseInt(sigHex.slice(130, 132), 16),
    r: with0x(sigHex.slice(2, 66)),
    s: with0x(sigHex.slice(66, 130)),
  };
}

/** Withdraw `amtWei` for period `i`. Pass `approver` only when amt > perTxMax. */
export async function withdraw(
  client: Client,
  contractId: string,
  w: { i: number; amtWei: bigint; agent: WithdrawSig; approver?: WithdrawSig },
): Promise<string> {
  const a = w.agent;
  const o = w.approver ?? ZERO_SIG;
  const params = new ContractFunctionParameters()
    .addUint256(u256(w.i))
    .addUint256(u256(w.amtWei))
    .addUint8(a.v)
    .addBytes32(hexToBytes(a.r))
    .addBytes32(hexToBytes(a.s))
    .addUint8(o.v)
    .addBytes32(hexToBytes(o.r))
    .addBytes32(hexToBytes(o.s));
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(1_000_000)
    .setFunction("withdraw", params)
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}

/** Owner reclaims the unspent remainder of period `i` (only after its window ends). */
export async function reclaim(client: Client, contractId: string, i: number): Promise<string> {
  const resp = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(300_000)
    .setFunction("reclaim", new ContractFunctionParameters().addUint256(u256(i)))
    .execute(client);
  return (await resp.getReceipt(client)).status.toString();
}
