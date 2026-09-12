/**
 * NotYet MCP — timelocked spend authority, as an adoptable capability.
 *
 * This is NotYet's agent-facing SDK surface exposed over MCP, so *any* agent (Claude,
 * Cursor, ChatGPT, a custom loop) can adopt time-gated spend authority in one line, and any
 * human can run it with zero config. It is deliberately NOT a bespoke "payment gateway":
 * three of the four tools are read-only and need no keys, and the capability is generic —
 * "unlock authority that does not exist until its time, then act within its on-chain limits."
 *
 * Tools:
 *   notyet_explain()                                  -> what NotYet is + how to integrate (no input)
 *   notyet_status(topicId)                            -> per-period state (locked | ready), read-only
 *   notyet_verify(topicId, issuer)                    -> is the schedule signed by the trusted issuer? read-only
 *   notyet_spend(topicId, issuer, index[, serviceUrl]) -> the one guarded action: unlock (NOT_YET if early),
 *                                                        withdraw from the on-chain PeriodVault, settle x402
 *
 * Read-only tools work against any public NotYet topic with no configuration. Only
 * notyet_spend needs operator config (a Hedera payer; a vault + agent account for vault mode)
 * — set it to spend against your own deployment. See the "env" notes below.
 *
 * Run locally (stdio):  npx tsx bazantic/mcp-server.ts
 * Or add the hosted one: claude mcp add --transport http notyet <your bazgateway.com URL>/mcp
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client, PrivateKey, AccountId, Hbar } from "@hiero-ledger/sdk";
import { readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundUnlockMs } from "../sdk/tlock.js";
import { resolveSchedule, UntrustedScheduleError } from "../agent/resolve.js";
import { payX402 } from "../sdk/pay.js";
import { withdraw, signWithdraw, VAULT_ARTIFACT, HEDERA_TESTNET_CHAINID } from "../sdk/vault.js";
import { hederaRelayClient } from "../sdk/vault-relay.js";

const DEFAULT_SERVICE = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/price` : "https://notyet.up.railway.app/price";
const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

// Only notyet_spend needs these. Read-only tools work without any of it.
// - vault mode: DEMO_VAULT_ID/EVM + DEMO_AGENT_ID/KEY + HEDERA_PAYER_ID/KEY (spends via the PeriodVault)
// - account mode (fallback): no config needed — the period's own funded account pays directly
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

const server = new McpServer({ name: "NotYet", version: "0.2.0" });

// ── notyet_explain — self-documenting onboarding, so an agent can adopt it unaided ──────────
server.registerTool(
  "notyet_explain",
  {
    description: "Explain what NotYet is and how to integrate it. Call this first to understand the capability before using the other tools. Takes no input.",
    inputSchema: {},
  },
  async () =>
    ok({
      what: "NotYet gives an agent time-gated spend authority. A schedule is split into periods; each period's spend key is timelock-encrypted (drand/tlock) to a future moment, so it does not exist in usable form before its time. A compromised agent can spend at most the one period that is currently unlocked — never the whole budget, and never a future period.",
      model: {
        trust: "A schedule is signed by an issuer (a Ledger key). Verify it with notyet_verify before acting.",
        unlock: "Each period unlocks on its drand round. Before that, spending returns NOT_YET — the key genuinely does not exist yet.",
        limits: "Spending is gated on-chain by a PeriodVault contract on Hedera: time window + committed key identity + budget + per-tx ceiling.",
      },
      howToIntegrate: [
        "1. notyet_status(topicId) — see which periods are locked vs ready.",
        "2. notyet_verify(topicId, issuer) — confirm the schedule is signed by the issuer you trust.",
        "3. notyet_spend(topicId, issuer, index) — spend one ready period (settles an x402 payment); returns NOT_YET if its time has not come.",
      ],
      toIssueSchedules: "Creating schedules (the owner side) uses the NotYet SDK / dashboard, not this MCP. See the repo.",
      repo: "https://github.com/0xkeccak/NotYet",
      network: "hedera:testnet",
    }),
);

// ── notyet_status — read-only, no config needed ─────────────────────────────────────────────
server.registerTool(
  "notyet_status",
  {
    description: "List the periods on a NotYet schedule (HCS topic) and whether each is locked or ready to spend. Read-only; needs no configuration.",
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

// ── notyet_verify — read-only trust check ───────────────────────────────────────────────────
server.registerTool(
  "notyet_verify",
  {
    description: "Check whether a NotYet schedule is signed by the issuer you trust (the root of trust). Returns the verified schedule summary, or verified:false if the signature does not match. Read-only; needs no configuration. Always verify before spending.",
    inputSchema: {
      topicId: z.string().describe("Hedera HCS topic id carrying the schedule"),
      issuer: z.string().describe("0x issuer address the schedule must be signed by"),
    },
  },
  async ({ topicId, issuer }) => {
    try {
      const s = await resolveSchedule(topicId, issuer);
      return ok({
        verified: true,
        issuer: s.issuerPubKey,
        network: s.network,
        agentId: s.agentId,
        periods: s.periods.length,
        createdMs: s.createdMs,
      });
    } catch (e) {
      if (e instanceof UntrustedScheduleError) return ok({ verified: false, reason: "schedule is not signed by the expected issuer" });
      return ok({ verified: false, reason: (e as Error).message });
    }
  },
);

// ── notyet_spend — the one guarded action ───────────────────────────────────────────────────
server.registerTool(
  "notyet_spend",
  {
    description:
      "Spend one ready period's authority. Verifies the schedule is signed by the trusted issuer, unlocks the period's timelocked key (returns NOT_YET if its drand round has not arrived), withdraws that period's budget from the on-chain PeriodVault (window + key identity + budget enforced by the contract), and settles the x402 payment from the released funds. Returns the vault withdrawal + the settlement. This is the only tool that moves funds.",
    inputSchema: {
      topicId: z.string().describe("Hedera HCS topic id carrying the schedule + ciphertexts"),
      issuer: z.string().describe("0x issuer address the schedule must be signed by (trust anchor)"),
      index: z.number().int().describe("period index to spend"),
      serviceUrl: z.string().optional().describe(`x402 service URL to pay (default ${DEFAULT_SERVICE})`),
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
        const c = hederaClient();
        const spent = await onchainSpent(p.vaultIndex);
        const sig = await signWithdraw(key, { contractEvm: VAULT_EVM, chainId: HEDERA_TESTNET_CHAINID, i: p.vaultIndex, amtTinybar: WITHDRAW_TINYBAR, spentTinybar: spent, tag: "agent" });
        await withdraw(c, VAULT_ID!, { i: p.vaultIndex, amtTinybar: WITHDRAW_TINYBAR, agent: sig });
        c.close();
        withdrawLink = `https://hashscan.io/testnet/contract/${VAULT_ID}`;
        payer = { accountId: AGENT_ID, privateKey: AGENT_KEY }; // pays x402 from the released funds
      } else {
        payer = { accountId: p.accountId!, privateKey: key }; // account mode: the period's own funded account pays
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
