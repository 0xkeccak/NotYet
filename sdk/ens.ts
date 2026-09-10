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

/* -------------------------------------------------------------------------- *
 * Agent identity on ENS — the ENS-blessed, text-record-based standards for AI
 * agents (no subnames / registry changes needed):
 *   ENSIP-26 "Agent Text Records": agent-context + agent-endpoint[<protocol>]
 *   ENSIP-25 "AI Agent Registry verification": agent-registration[<registry>][<id>]
 * This lets `mujahid.eth` *be* the Notyet agent's discoverable identity: what it is,
 * and how to reach it over web / a2a (its x402 pay endpoint) / mcp.
 * -------------------------------------------------------------------------- */

export const AGENT_CONTEXT_KEY = "agent-context"; // ENSIP-26
export type AgentProtocol = "mcp" | "a2a" | "web";
export const agentEndpointKey = (proto: AgentProtocol) => `agent-endpoint[${proto}]`; // ENSIP-26
/** ENSIP-25: <registry> is an ERC-7930 interoperable address, <agentId> the registry id. */
export const agentRegistrationKey = (registry: string, agentId: string) => `agent-registration[${registry}][${agentId}]`;

export interface AgentRecords {
  context: string; // ENSIP-26 agent-context (markdown/plain)
  endpoints: Partial<Record<AgentProtocol, string>>; // ENSIP-26 agent-endpoint[*]
}

/** Publish ENSIP-26 agent records (agent-context + agent-endpoint[*]) to an ENS name. */
export async function publishAgentRecords(
  rpcUrl: string,
  ownerPrivateKey: `0x${string}`,
  name: string,
  rec: AgentRecords,
): Promise<`0x${string}`[]> {
  const txs: `0x${string}`[] = [];
  txs.push(await writeText(rpcUrl, ownerPrivateKey, name, AGENT_CONTEXT_KEY, rec.context));
  for (const proto of ["mcp", "a2a", "web"] as const) {
    const url = rec.endpoints[proto];
    if (url) txs.push(await writeText(rpcUrl, ownerPrivateKey, name, agentEndpointKey(proto), url));
  }
  return txs;
}

/** Read ENSIP-26 agent records back from an ENS name. */
export async function readAgentRecords(rpcUrl: string, name: string): Promise<AgentRecords> {
  const context = await readText(rpcUrl, name, AGENT_CONTEXT_KEY);
  const endpoints: Partial<Record<AgentProtocol, string>> = {};
  for (const proto of ["mcp", "a2a", "web"] as const) {
    const v = await readText(rpcUrl, name, agentEndpointKey(proto));
    if (v) endpoints[proto] = v;
  }
  return { context, endpoints };
}

/** ENSIP-25: attest that this ENS name is the agent <agentId> in <registry> (value "1"). */
export async function attestAgentRegistration(
  rpcUrl: string,
  ownerPrivateKey: `0x${string}`,
  name: string,
  registry: string,
  agentId: string,
): Promise<`0x${string}`> {
  return writeText(rpcUrl, ownerPrivateKey, name, agentRegistrationKey(registry, agentId), "1");
}
