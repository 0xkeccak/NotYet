/**
 * ENS (Sepolia, ENSv2) — the agent's root of trust.
 *
 * The owner publishes the signed schedule + issuer address as text records on their
 * ENS name; the agent reads them and refuses to act if the signature doesn't verify.
 * Uses ensjs so it works with the ENSv2 registry/resolver (the classic viem registry
 * helpers don't see ENSv2 names). ENS on Sepolia *names* the agent and points to the
 * Hedera account / HCS topic on the other chain — no bridge.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { addEnsContracts } from "@ensdomains/ensjs";
import { getTextRecord, getResolver } from "@ensdomains/ensjs/public";
import { setTextRecord } from "@ensdomains/ensjs/wallet";

export const SCHEDULE_KEY = "notyet:schedule"; // signed schedule JSON
export const ISSUER_KEY = "notyet:issuer"; // issuer (master) address

const ensChain = addEnsContracts(sepolia);

function pub(rpcUrl: string) {
  return createPublicClient({ chain: ensChain, transport: http(rpcUrl) });
}

/** Read one text record from an ENS name (ENSv2-aware). Returns "" if unset. */
export async function readText(rpcUrl: string, name: string, key: string): Promise<string> {
  const value = await getTextRecord(pub(rpcUrl), { name, key });
  return value ?? "";
}

/** The name's resolver address (needed for writes). */
export async function resolverOf(rpcUrl: string, name: string): Promise<`0x${string}` | null> {
  return (await getResolver(pub(rpcUrl), { name })) as `0x${string}` | null;
}

/** Write one text record to an ENS name. Requires the name owner's key. Returns the tx hash. */
export async function writeText(
  rpcUrl: string,
  ownerPrivateKey: `0x${string}`,
  name: string,
  key: string,
  value: string,
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(ownerPrivateKey);
  const wallet = createWalletClient({ account, chain: ensChain, transport: http(rpcUrl) });
  const resolverAddress = await resolverOf(rpcUrl, name);
  if (!resolverAddress) throw new Error(`${name} has no resolver set — set one before writing records`);
  const hash = await setTextRecord(wallet, { name, key, value, resolverAddress });
  await pub(rpcUrl).waitForTransactionReceipt({ hash });
  return hash;
}
