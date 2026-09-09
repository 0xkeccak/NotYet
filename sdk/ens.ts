/**
 * ENS (Sepolia) — the agent's root of trust.
 *
 * The owner publishes the signed schedule + issuer pubkey as text records on their
 * ENS name. The agent reads them and refuses to act if the signature doesn't verify.
 * ENS on Sepolia *names* the agent; it just points to the Hedera account / HCS topic
 * that live on the other chain. No bridge — two independent writes.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  namehash,
  getContract,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

/** Text-record keys Notyet writes. */
export const SCHEDULE_KEY = "notyet:schedule"; // signed schedule JSON
export const ISSUER_KEY = "notyet:issuer"; // issuer (master) public key

// Minimal resolver ABI — just the text record get/set.
const RESOLVER_ABI = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
] as const;

function publicClient(rpcUrl: string) {
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
}

/** Read one text record from an ENS name. Returns "" if unset. */
export async function readText(rpcUrl: string, name: string, key: string): Promise<string> {
  const client = publicClient(rpcUrl);
  const resolver = await client.getEnsResolver({ name });
  const value = await client.readContract({
    address: resolver,
    abi: RESOLVER_ABI,
    functionName: "text",
    args: [namehash(name), key],
  });
  return value ?? "";
}

/** Write one text record to an ENS name. Requires the name owner's key. Returns the tx hash. */
export async function writeText(
  rpcUrl: string,
  ownerPrivateKey: `0x${string}`,
  name: string,
  key: string,
  value: string,
): Promise<`0x${string}`> {
  const pub = publicClient(rpcUrl);
  const resolver = (await pub.getEnsResolver({ name })) as Address;
  const account = privateKeyToAccount(ownerPrivateKey);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  const contract = getContract({ address: resolver, abi: RESOLVER_ABI, client: wallet });
  const hash = await contract.write.setText([namehash(name), key, value]);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
