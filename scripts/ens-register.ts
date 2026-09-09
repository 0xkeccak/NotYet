/**
 * One-time: register the ENS name on Sepolia to the owner account, with the public
 * resolver set. Talks to the ETHRegistrarController directly and computes the
 * commitment via the controller's OWN makeCommitment view (so it always matches the
 * deployed version). commit -> wait minCommitmentAge -> register.
 * Run once: npx tsx scripts/ens-register.ts
 */
import "dotenv/config";
import { createPublicClient, createWalletClient, http, zeroHash, keccak256, toHex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { addEnsContracts } from "@ensdomains/ensjs";
import {
  ethRegistrarControllerRegisterSnippet,
  ethRegistrarControllerCommitSnippet,
  ethRegistrarControllerRentPriceSnippet,
  ethRegistrarControllerErrors,
} from "@ensdomains/ensjs/contracts";

const rpc = process.env.SEPOLIA_RPC_URL!;
const fullName = process.env.ENS_NAME ?? "keccak.eth";
const label = fullName.replace(/\.eth$/, "");
const duration = 31_536_000n; // 1 year
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chain = addEnsContracts(sepolia);
const controller = chain.contracts.ensEthRegistrarController.address;
// Register with NO resolver first (isolates resolver sub-call reverts); set it after.
const resolver = "0x0000000000000000000000000000000000000000" as const;
const account = privateKeyToAccount(process.env.ENS_OWNER_KEY as `0x${string}`);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

// The Registration struct, shared by makeCommitment and register (must be identical).
const registration = {
  label,
  owner: account.address,
  duration,
  secret: keccak256(toHex(`notyet:${fullName}:v1`)), // fixed → idempotent commit/register retries
  resolver,
  data: [] as `0x${string}`[],
  reverseRecord: 0, // uint8
  referrer: zeroHash,
};

// makeCommitment(Registration) view — reuse the register tuple as its single input.
const regTuple = ethRegistrarControllerRegisterSnippet.find((x: any) => x.name === "register")!.inputs;
const makeCommitmentAbi = [
  { name: "makeCommitment", type: "function", stateMutability: "pure", inputs: regTuple, outputs: [{ type: "bytes32" }] },
] as const satisfies Abi;

console.log(`registering ${fullName} (label "${label}") to ${account.address}`);
console.log(`controller ${controller}, resolver ${resolver}`);

const commitment = (await pub.readContract({
  address: controller,
  abi: makeCommitmentAbi,
  functionName: "makeCommitment",
  args: [registration],
})) as `0x${string}`;
console.log("commitment:", commitment);

const commitmentsAbi = [
  { name: "commitments", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;
const committedAt = (await pub.readContract({ address: controller, abi: commitmentsAbi, functionName: "commitments", args: [commitment] })) as bigint;

if (committedAt === 0n) {
  const commitHash = await wallet.writeContract({ address: controller, abi: ethRegistrarControllerCommitSnippet, functionName: "commit", args: [commitment] });
  console.log("commit tx:", commitHash);
  await pub.waitForTransactionReceipt({ hash: commitHash });
  console.log("waiting 75s for the commitment to mature (minCommitmentAge=60s)…");
  await sleep(75_000);
} else {
  console.log("commitment already on-chain at ts", committedAt.toString(), "— skipping commit/wait");
}

const price = (await pub.readContract({
  address: controller,
  abi: ethRegistrarControllerRentPriceSnippet,
  functionName: "rentPrice",
  args: [label, duration],
})) as { base: bigint; premium: bigint };
const value = ((price.base + price.premium) * 110n) / 100n;
console.log("price (wei, +10%):", value.toString());

const registerAbi = [...ethRegistrarControllerRegisterSnippet, ...ethRegistrarControllerErrors] as const;
// Send the real tx (this RPC mangles eth_call revert data). Manual gas so a reverting
// estimate doesn't block submission; read the mined receipt for the true outcome.
const registerHash = await wallet.writeContract({
  address: controller,
  abi: registerAbi,
  functionName: "register",
  args: [registration],
  value,
  gas: 400_000n,
});
console.log("register tx:", registerHash);
const receipt = await pub.waitForTransactionReceipt({ hash: registerHash });
console.log("registered — status:", receipt.status, "| gasUsed:", receipt.gasUsed.toString());
console.log("etherscan:", `https://sepolia.etherscan.io/tx/${registerHash}`);
