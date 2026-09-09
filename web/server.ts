/**
 * Notyet dashboard API. Wraps the SDK so the UI can drive the whole flow live:
 *   POST /api/issue   -> issuer creates N period accounts, timelocks keys, posts to HCS
 *   GET  /api/status  -> per-period state (locked | ready | paid) from drand vs wall clock
 *   POST /api/pay     -> unlock a period (NOT_YET before its round) and pay the x402 service
 *   POST /api/audit   -> decrypt a period's receipts with its view key
 *
 * Demo-scale in-memory state (one active schedule). Run: npx tsx web/server.ts
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { Client, PrivateKey, AccountId } from "@hiero-ledger/sdk";
import { issuePeriod } from "../issuer/lock.js";
import { createTopic, submitMessage, readMessages } from "../sdk/hcs.js";
import { decryptCiphertext, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
import { encryptReceipt, decryptReceipt } from "../sdk/receipts.js";
import { payX402 } from "../sdk/pay.js";
import type { Receipt } from "../sdk/types.js";

const PORT = Number(process.env.WEB_PORT ?? 4040);
const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:4021/price";
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;

const client = () =>
  Client.forTestnet().setOperator(AccountId.fromString(payerId), PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")));

interface PeriodState {
  index: number;
  round: number;
  unlockMs: number;
  accountId: string;
  ciphertext: string;
  paid?: { tx: string; hashscan?: string; data: unknown };
}
const state: { topicId?: string; periodSec: number; masterView?: Buffer; periods: PeriodState[] } = {
  periodSec: 90,
  periods: [],
};

const app = express();
app.use(express.json());
app.use(express.static(new URL("./public", import.meta.url).pathname));

app.post("/api/issue", async (req: Request, res: Response) => {
  try {
    const count = Math.min(Number(req.body?.count ?? 3), 5);
    const c = client();
    const topicId = await createTopic(c, "notyet-dash");
    const master = newMasterViewSecret();
    const now = Date.now();
    const periods: PeriodState[] = [];
    for (let i = 0; i < count; i++) {
      const round = roundForTime(now + (i === 0 ? 8_000 : i * state.periodSec * 1000));
      const p = await issuePeriod(c, { index: i, round, budgetTinybars: "50000000" });
      await submitMessage(c, topicId, JSON.stringify({ index: i, round, accountId: p.accountId, ciphertext: p.ciphertext }));
      periods.push({ index: i, round, unlockMs: roundUnlockMs(round), accountId: p.accountId, ciphertext: p.ciphertext });
    }
    c.close();
    state.topicId = topicId;
    state.masterView = master;
    state.periods = periods;
    res.json({ topicId, count, periods: periods.map(({ ciphertext, ...p }) => p) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status", (_req: Request, res: Response) => {
  const now = Date.now();
  res.json({
    topicId: state.topicId,
    periods: state.periods.map((p) => ({
      index: p.index,
      round: p.round,
      accountId: p.accountId,
      hashscanAccount: `https://hashscan.io/testnet/account/${p.accountId}`,
      state: p.paid ? "paid" : now >= p.unlockMs ? "ready" : "locked",
      secondsToUnlock: Math.max(0, Math.round((p.unlockMs - now) / 1000)),
      paid: p.paid,
    })),
  });
});

app.post("/api/pay", async (req: Request, res: Response) => {
  const p = state.periods.find((x) => x.index === Number(req.body?.index));
  if (!p) return res.status(404).json({ error: "no such period" });
  try {
    const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
    const result = await payX402(SERVICE_URL, { accountId: p.accountId, privateKey: key });
    if (result.paid && state.topicId && state.masterView) {
      const receipt: Receipt = { periodIndex: p.index, service: "price", amount: "100000", timestampMs: Date.now(), resultHash: "demo" };
      await submitMessage(client(), state.topicId, encryptReceipt(receipt, deriveViewKey(state.masterView, p.index)));
      p.paid = { tx: result.settlement!, hashscan: result.hashscan, data: result.data };
    }
    res.json({ paid: result.paid, ...p.paid });
  } catch (e: any) {
    res.json({ paid: false, notYet: isNotYet(e), error: isNotYet(e) ? `NOT_YET — key for period ${p.index} does not exist until round ${p.round}` : e.message });
  }
});

app.post("/api/audit", async (req: Request, res: Response) => {
  if (!state.topicId || !state.masterView) return res.status(400).json({ error: "no active schedule" });
  const index = Number(req.body?.index);
  try {
    const viewKey = deriveViewKey(state.masterView, index);
    const msgs = await readMessages(state.topicId);
    const decrypted: Receipt[] = [];
    let othersTried = 0;
    let othersFailed = 0;
    for (const m of msgs) {
      try {
        decrypted.push(decryptReceipt(m.contents, viewKey));
      } catch {
        // not a receipt for this period (ciphertext JSON or another period)
      }
    }
    // demonstrate scoping: try decrypting with a neighbor key, expect failure
    for (const m of msgs) {
      try {
        decryptReceipt(m.contents, deriveViewKey(state.masterView, index + 1));
        othersTried++;
      } catch {
        othersTried++;
        othersFailed++;
      }
    }
    res.json({ index, receipts: decrypted, scopedProof: `${othersFailed}/${othersTried} messages unreadable with a different period's key` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Notyet dashboard on http://localhost:${PORT}`));
