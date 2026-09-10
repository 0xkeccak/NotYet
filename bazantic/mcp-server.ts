/**
 * Notyet MCP server (Bazantic "Agentify a New API").
 *
 * Exposes Notyet's timelocked x402 pay capability as MCP tools so *other* agents can
 * discover and call it — agent-to-agent payments with a built-in safety property (a key
 * that doesn't exist before its time). Wraps the same SDK the dashboard uses.
 *
 * Tools:
 *   notyet_status(topicId)                          -> per-period state (locked | ready)
 *   notyet_pay(topicId, issuer, index[, serviceUrl]) -> verify trust, unlock (NOT_YET if
 *                                                       early), pay the x402 service, return
 *                                                       the settlement + data
 *
 * Run (stdio): npx tsx bazantic/mcp-server.ts
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundUnlockMs } from "../sdk/tlock.js";
import { resolveSchedule } from "../agent/resolve.js";
import { payX402 } from "../sdk/pay.js";

const DEFAULT_SERVICE = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/price` : "https://notyet.up.railway.app/price";
const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

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
    .filter((x) => x && x.ciphertext) as Array<{ index: number; round: number; accountId: string; ciphertext: string }>;
}

const server = new McpServer({ name: "notyet", version: "0.1.0" });

server.registerTool(
  "notyet_status",
  {
    description: "List the periods on a Notyet HCS topic and whether each is locked or ready to spend.",
    inputSchema: { topicId: z.string().describe("Hedera HCS topic id, e.g. 0.0.123456") },
  },
  async ({ topicId }) => {
    const cts = await ciphertexts(topicId);
    const now = Date.now();
    return ok(
      cts.map((c) => ({
        index: c.index,
        round: c.round,
        accountId: c.accountId,
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
      "Verify the schedule on the topic is signed by the trusted issuer, unlock the given period's timelocked key (returns NOT_YET if its drand round hasn't arrived), and pay the x402 service. Returns the settlement.",
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
    // 3 · unlock (NOT_YET before its round) then pay
    try {
      const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
      const result = await payX402(serviceUrl ?? DEFAULT_SERVICE, { accountId: p.accountId, privateKey: key });
      return ok({ paid: result.paid, settlement: result.settlement, hashscan: result.hashscan, data: result.data });
    } catch (e) {
      if (isNotYet(e)) return ok({ paid: false, notYet: true, message: `NOT_YET — period ${index}'s key does not exist until round ${p.round}` });
      throw e;
    }
  },
);

await server.connect(new StdioServerTransport());
