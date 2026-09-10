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
import { createScheduledTransfer, signScheduled, scheduleStatus, txIdToHashscan } from "../sdk/scheduled.js";
import { mountX402 } from "../service/server.js";
import type { Receipt } from "../sdk/types.js";

const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 4040); // Railway sets PORT
// The x402-gated /price is hosted on THIS app (see mountX402 below), so it's public on
// the hosted URL and the dashboard's own /api/pay hits it on the same port.
const SERVICE_URL = process.env.SERVICE_URL ?? `http://localhost:${PORT}/price`;
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;

// Light global cooldown on issue so a public URL can't drain the faucet-funded payer.
let lastIssueMs = 0;
const ISSUE_COOLDOWN_MS = Number(process.env.ISSUE_COOLDOWN_MS ?? 60_000);

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
  periodSec: 15, // short by default so the whole cycle plays in under a minute (demo/video)
  periods: [],
};

// A single active scheduled transfer (HIP-423 "sign-on-unlock" mode). Demo-scale, in-memory.
interface SchedState {
  scheduleId: string;
  scheduledTxId: string;
  round: number;
  unlockMs: number;
  accountId: string;
  ciphertext: string;
  tinybars: number;
  executed?: { tx: string; hashscan: string };
}
let sched: SchedState | undefined;
let lastSchedMs = 0;

const app = express();
app.use(express.json());
app.use(express.static(new URL("./public", import.meta.url).pathname));

// Host the real x402-gated service on the public app: GET /price returns 402 with an
// x402 challenge and settles through Blocky402 when paid. Reachable at <host>/price.
mountX402(app);

app.post("/api/issue", async (req: Request, res: Response) => {
  const wait = lastIssueMs + ISSUE_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `cooling down — try again in ${Math.ceil(wait / 1000)}s` });
  lastIssueMs = Date.now();
  try {
    const count = Math.min(Number(req.body?.count ?? 3), 5);
    state.periodSec = Math.max(8, Math.min(120, Number(req.body?.periodSec ?? 15)));
    const c = client();
    const topicId = await createTopic(c, "notyet-dash");
    const master = newMasterViewSecret();
    const now = Date.now();
    const periods: PeriodState[] = [];
    for (let i = 0; i < count; i++) {
      // first period unlocks in ~8s, each next one staggers by the cadence (so a short
      // demo cadence like 8s plays out as 8s / 16s / 24s — clean for the video)
      const round = roundForTime(now + 8_000 + i * state.periodSec * 1000);
      const p = await issuePeriod(c, { index: i, round, budgetTinybars: "3000000" });
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

// Recent settlements — real, always-populated history straight from the merchant
// account on the mirror node (survives restarts and is verifiable on HashScan). This is
// what makes "show me a past run" work even on a freshly-booted instance.
const MERCHANT_ID = process.env.HEDERA_MERCHANT_ID!;
const MIRROR = process.env.HEDERA_NETWORK === "mainnet" ? "https://mainnet.mirrornode.hedera.com" : "https://testnet.mirrornode.hedera.com";
app.get("/api/recent", async (_req: Request, res: Response) => {
  try {
    const url = `${MIRROR}/api/v1/transactions?account.id=${MERCHANT_ID}&transactiontype=cryptotransfer&result=success&order=desc&limit=8`;
    const data: any = await fetch(url).then((r) => r.json());
    const items = (data.transactions ?? [])
      .map((t: any) => {
        // amount credited to the merchant in this transfer (tinybars)
        const credit = (t.transfers ?? []).find((x: any) => x.account === MERCHANT_ID && x.amount > 0);
        return {
          txId: t.transaction_id,
          hashscan: `https://hashscan.io/testnet/transaction/${t.transaction_id}`,
          tinybars: credit?.amount ?? 0,
          consensusMs: Math.round(Number(t.consensus_timestamp) * 1000),
        };
      })
      .filter((x: any) => x.tinybars > 0); // only inbound settlements, not funding/fees
    res.json({ merchant: MERCHANT_ID, hashscanAccount: `https://hashscan.io/testnet/account/${MERCHANT_ID}`, settlements: items });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Scheduled transfer (HIP-423, sign-on-unlock) ----
// Pick a time → we create + fund a period account, timelock its key to that round, and
// post a PENDING scheduled transfer (from that account → merchant) with no signature.
// It's public and inert on-chain. At the round the agent decrypts the key and signs;
// only then does it execute. Nobody ever holds the key early — that's the whole point.
app.post("/api/schedule", async (req: Request, res: Response) => {
  const wait = lastSchedMs + ISSUE_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `cooling down — try again in ${Math.ceil(wait / 1000)}s` });
  lastSchedMs = Date.now();
  try {
    const seconds = Math.max(8, Math.min(300, Number(req.body?.seconds ?? 10)));
    const amtHbar = Math.max(0.01, Math.min(0.1, Number(req.body?.amount ?? 0.02)));
    const tinybars = Math.round(amtHbar * 1e8);
    const round = roundForTime(Date.now() + seconds * 1000);
    const c = client();
    // fund the sender a little above the transfer so it can cover the debit (fees are on the operator)
    const p = await issuePeriod(c, { index: 0, round, budgetTinybars: String(tinybars + 1_000_000) });
    const { scheduleId, scheduledTxId } = await createScheduledTransfer(c, {
      fromAccountId: p.accountId,
      toAccountId: MERCHANT_ID,
      tinybars,
      expirationSec: seconds + 300, // generous deadline so the unlocked key can still sign
    });
    c.close();
    sched = { scheduleId, scheduledTxId, round, unlockMs: roundUnlockMs(round), accountId: p.accountId, ciphertext: p.ciphertext, tinybars };
    res.json({
      scheduleId,
      accountId: p.accountId,
      round,
      amount: amtHbar,
      secondsToUnlock: seconds,
      hashscanSchedule: `https://hashscan.io/testnet/schedule/${scheduleId}`,
      hashscanAccount: `https://hashscan.io/testnet/account/${p.accountId}`,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/schedule/status", async (_req: Request, res: Response) => {
  if (!sched) return res.json({ none: true });
  const now = Date.now();
  if (!sched.executed) {
    const st = await scheduleStatus(sched.scheduleId).catch(() => ({ executed: false }));
    if (st.executed) sched.executed = { tx: sched.scheduledTxId, hashscan: txIdToHashscan(sched.scheduledTxId) };
  }
  res.json({
    scheduleId: sched.scheduleId,
    accountId: sched.accountId,
    round: sched.round,
    amount: sched.tinybars / 1e8,
    hashscanSchedule: `https://hashscan.io/testnet/schedule/${sched.scheduleId}`,
    hashscanAccount: `https://hashscan.io/testnet/account/${sched.accountId}`,
    state: sched.executed ? "executed" : now >= sched.unlockMs ? "ready" : "locked",
    secondsToUnlock: Math.max(0, Math.round((sched.unlockMs - now) / 1000)),
    executed: sched.executed,
  });
});

app.post("/api/schedule/execute", async (_req: Request, res: Response) => {
  if (!sched) return res.status(404).json({ error: "no scheduled transfer" });
  if (sched.executed) return res.json({ executed: true, ...sched.executed });
  try {
    // decrypt throws NOT_YET before the round — no key, so no signature, so it can't fire
    const key = (await decryptCiphertext(sched.ciphertext)).toString("utf8");
    const c = client();
    const status = await signScheduled(c, sched.scheduleId, key);
    c.close();
    sched.executed = { tx: sched.scheduledTxId, hashscan: txIdToHashscan(sched.scheduledTxId) };
    res.json({ executed: true, status, ...sched.executed });
  } catch (e: any) {
    res.json({
      executed: false,
      notYet: isNotYet(e),
      error: isNotYet(e)
        ? `NOT_YET — the key that signs this transfer does not exist until round ${sched.round}`
        : e.message,
    });
  }
});

app.listen(PORT, () => console.log(`Notyet dashboard on http://localhost:${PORT}`));
