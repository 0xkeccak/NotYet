/**
 * NotYet MCP server (Bazantic "Agentify a New API").
 *
 * Exposes NotYet's timelocked x402 pay capability as MCP tools so *other* agents can
 * discover and call it — agent-to-agent payments with a built-in safety property (a key
 * that doesn't exist before its time). Wraps the same on-chain PeriodVault path the
 * dashboard uses: unlock the period key -> withdraw from the vault (window + budget enforced
 * on-chain) -> pay the x402 service. Falls back to the per-period account model if no vault
 * is configured.
 *
 * Tools:
 *   notyet_status(topicId)                          -> per-period state (locked | ready)
 *   notyet_pay(topicId, issuer, index[, serviceUrl]) -> verify trust, unlock (NOT_YET if
 *                                                       early), withdraw from the vault, pay
 *                                                       the x402 service, return withdrawal +
 *                                                       settlement + data
 *
 * Run (stdio): npx tsx bazantic/mcp-server.ts
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client, PrivateKey, AccountId, Hbar } from "@hiero-ledger/sdk";
import { readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundUnlockMs } from "../sdk/tlock.js";
import { resolveSchedule } from "../agent/resolve.js";
import { payX402 } from "../sdk/pay.js";
import { withdraw, signWithdraw, VAULT_ARTIFACT, HEDERA_TESTNET_CHAINID } from "../sdk/vault.js";
import { hederaRelayClient } from "../sdk/vault-relay.js";

const DEFAULT_SERVICE = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/price` : "https://notyet.up.railway.app/price";
const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

// Vault mode: when the demo vault + agent account are configured, notyet_pay drives the same
// on-chain PeriodVault path the dashboard uses (unlock -> withdraw -> x402) instead of the
// per-period account fallback. Amount released per pay covers the 100000-tinybar x402 price.
const VAULT_ID = process.env.DEMO_VAULT_ID;
const VAULT_EVM = (process.env.DEMO_VAULT_EVM ?? "") as `0x${string}`;
const AGENT_ID = process.env.DEMO_AGENT_ID ?? "";
const AGENT_KEY = process.env.DEMO_AGENT_KEY ?? "";
const VAULT_MODE = Boolean(VAULT_ID && VAULT_EVM && AGENT_ID && AGENT_KEY && process.env.HEDERA_PAYER_ID && process.env.HEDERA_PAYER_KEY);
const WITHDRAW_TINYBAR = 120_000n;

const hederaClient = () =>
  Client.forTestnet()
    .setOperator(AccountId.fromString(process.env.HEDERA_PAYER_ID!), PrivateKey.fromStringECDSA(process.env.HEDERA_PAYER_KEY!.replace(/^0x/, "")))
    .setDefaultMaxTransactionFee(new Hbar(20));

/** Read a period's current on-chain `spent` so the withdraw signature's nonce matches. */
async function onchainSpent(vaultIndex: number): Promise<bigint> {
  const p = (await hederaRelayClient().readContract({ address: VAULT_EVM, abi: VAULT_ARTIFACT.abi as any, functionName: "periods", args: [BigInt(vaultIndex)] })) as any[];
  return BigInt(p[2]); // struct: (signer, budget, spent, ...)
}

async function ciphertexts(topicId: string) {
  const msgs = await readMessages(topicId);
  return msgs
    .map((m) => {
      try {
        return JSON.parse(m.contents);
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.ciphertext) as Array<{ index: number; round: number; accountId?: string; vaultIndex?: number; ciphertext: string }>;
}

const server = new McpServer({ name: "NotYet", version: "0.1.0" });

server.registerTool(
  "notyet_status",
  {
    description: "List the periods on a NotYet HCS topic and whether each is locked or ready to spend.",
    inputSchema: { topicId: z.string().describe("Hedera HCS topic id, e.g. 0.0.123456") },
  },
  async ({ topicId }) => {
    const cts = await ciphertexts(topicId);
    const now = Date.now();
    return ok(
      cts.map((c) => ({
        index: c.index,
        round: c.round,
        ...(c.vaultIndex !== undefined ? { vaultIndex: c.vaultIndex } : { accountId: c.accountId }),
        state: now >= roundUnlockMs(c.round) ? "ready" : "locked",
        secondsToUnlock: Math.max(0, Math.round((roundUnlockMs(c.round) - now) / 1000)),
      })),
    );
  },
);

server.registerTool(
  "notyet_pay",
  {
    description:
      "Verify the schedule on the topic is signed by the trusted issuer, unlock the given period's timelocked key (returns NOT_YET if its drand round hasn't arrived), withdraw that period's budget from the on-chain PeriodVault (window + ecrecover + budget enforced by the contract), and pay the x402 service from the released funds. Returns the vault withdrawal + the settlement.",
    inputSchema: {
      topicId: z.string().describe("Hedera HCS topic id carrying the schedule + ciphertexts"),
      issuer: z.string().describe("0x issuer address the schedule must be signed by (trust anchor)"),
      index: z.number().int().describe("period index to spend"),
      serviceUrl: z.string().optional().describe(`x402 service URL (default ${DEFAULT_SERVICE})`),
    },
  },
  async ({ topicId, issuer, index, serviceUrl }) => {
    // 1 · trust: refuse unless the schedule on the topic is signed by the expected issuer
    await resolveSchedule(topicId, issuer);
    // 2 · find the period's ciphertext
    const p = (await ciphertexts(topicId)).find((c) => c.index === index);
    if (!p) return ok({ error: `no period ${index} on topic ${topicId}` });
    // 3 · unlock (NOT_YET before its round), then withdraw from the vault and pay
    try {
      const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
      let withdrawLink: string | undefined;
      let payer: { accountId: string; privateKey: string };
      if (VAULT_MODE && p.vaultIndex !== undefined) {
        // sign a withdraw with the unlocked key; the contract enforces window + ecrecover +
        // budget (+ perTxMax escalation) on-chain, releasing funds into the fixed agent account
        const c = hederaClient();
        const spent = await onchainSpent(p.vaultIndex);
        const sig = await signWithdraw(key, { contractEvm: VAULT_EVM, chainId: HEDERA_TESTNET_CHAINID, i: p.vaultIndex, amtTinybar: WITHDRAW_TINYBAR, spentTinybar: spent, tag: "agent" });
        await withdraw(c, VAULT_ID!, { i: p.vaultIndex, amtTinybar: WITHDRAW_TINYBAR, agent: sig });
        c.close();
        withdrawLink = `https://hashscan.io/testnet/contract/${VAULT_ID}`;
        payer = { accountId: AGENT_ID, privateKey: AGENT_KEY }; // pays x402 from the released funds
      } else {
        payer = { accountId: p.accountId!, privateKey: key }; // fallback: pay straight from the period account
      }
      const result = await payX402(serviceUrl ?? DEFAULT_SERVICE, payer);
      return ok({ paid: result.paid, withdraw: withdrawLink, settlement: result.settlement, hashscan: result.hashscan, data: result.data });
    } catch (e) {
      if (isNotYet(e)) return ok({ paid: false, notYet: true, message: `NOT_YET — period ${index}'s key does not exist until round ${p.round}` });
      throw e;
    }
  },
);

await server.connect(new StdioServerTransport());
