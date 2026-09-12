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
import { decryptCiphertext, encryptToRound, isNotYet, roundForTime, roundUnlockMs } from "../sdk/tlock.js";
import { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
import { encryptReceipt, decryptReceipt } from "../sdk/receipts.js";
import { payX402 } from "../sdk/pay.js";
import { commitPeriod, withdraw, signWithdraw, evmAddressOf, HEDERA_TESTNET_CHAINID } from "../sdk/vault.js";
import { generatePrivateKey } from "viem/accounts";
import { createScheduledTransfer, signScheduled, scheduleStatus, txIdToHashscan } from "../sdk/scheduled.js";
import { mountX402 } from "../service/server.js";
import type { Receipt } from "../sdk/types.js";

const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 4040); // Railway sets PORT
// The x402-gated /price is hosted on THIS app (see mountX402 below), so it's public on
// the hosted URL and the dashboard's own /api/pay hits it on the same port.
const SERVICE_URL = process.env.SERVICE_URL ?? `http://localhost:${PORT}/price`;
const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;

// Per-session cooldown on issue so a public URL can't drain the faucet-funded payer,
// while two people demoing at once don't trip each other's limiter.
const ISSUE_COOLDOWN_MS = Number(process.env.ISSUE_COOLDOWN_MS ?? 60_000);

// Vault-backed money path (the shipped architecture): if a persistent PeriodVault + agent
// account are configured, /api/issue commits each period's key to the vault and /api/pay
// releases funds via a signed on-chain withdraw, then pays x402 from the agent account —
// "one contract, not N wallets". Falls back to per-period accounts if these are unset.
const VAULT_ID = process.env.DEMO_VAULT_ID;
const VAULT_EVM = process.env.DEMO_VAULT_EVM ?? "";
const AGENT_ID = process.env.DEMO_AGENT_ID ?? "";
const AGENT_KEY = process.env.DEMO_AGENT_KEY ?? "";
const VAULT_MODE = Boolean(VAULT_ID && VAULT_EVM && AGENT_ID && AGENT_KEY);
const WITHDRAW_TINYBAR = 120_000n; // released per pay (covers the 100000-tinybar x402 price)
const PERIOD_BUDGET = 1_000_000n; // per-period on-chain cap
const PERIOD_PERTXMAX = 500_000n; // above this a withdrawal needs the Ledger approver co-sign

const client = () =>
  Client.forTestnet().setOperator(AccountId.fromString(payerId), PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, "")));

interface PeriodState {
  index: number; // 0-based UI index
  vaultIndex?: number; // on-chain period key in the vault (vault mode)
  round: number;
  unlockMs: number;
  accountId?: string; // per-period account (fallback mode only)
  ciphertext: string;
  spent: bigint; // tinybar withdrawn so far this period (vault mode)
  paid?: { tx: string; hashscan?: string; data: unknown };
}
// A scheduled transfer (HIP-423 "sign-on-unlock" mode). Demo-scale, in-memory.
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

// Per-browser demo state, keyed by a client-generated session id, so concurrent judges
// don't clobber each other's schedule (or trip each other's cooldown). In-memory only —
// schedules reset on redeploy; the on-chain vault + HCS artifacts persist regardless.
interface Session {
  topicId?: string; vaultId?: string; periodSec: number; masterView?: Buffer; periods: PeriodState[];
  lastIssueMs: number; sched?: SchedState; lastSchedMs: number; lastSeenMs: number;
}
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60_000;
function sidOf(req: Request): string {
  const s = (req.body?.sid ?? req.query?.sid);
  return typeof s === "string" && s ? s.slice(0, 64) : "default";
}
function getSession(req: Request): Session {
  const sid = sidOf(req);
  let s = sessions.get(sid);
  if (!s) { s = { periodSec: 15, periods: [], lastIssueMs: 0, lastSchedMs: 0, lastSeenMs: Date.now() }; sessions.set(sid, s); }
  s.lastSeenMs = Date.now();
  if (sessions.size > 50) { const cut = Date.now() - SESSION_TTL_MS; for (const [k, v] of sessions) if (v.lastSeenMs < cut) sessions.delete(k); }
  return s;
}
// monotonic vault index so committed periods never collide across concurrent issues
let vaultSeq = Math.floor(Date.now() / 1000);

const app = express();
app.use(express.json());
app.use(express.static(new URL("./public", import.meta.url).pathname));

// Host the real x402-gated service on the public app: GET /price returns 402 with an
// x402 challenge and settles through Blocky402 when paid. Reachable at <host>/price.
mountX402(app);

app.post("/api/issue", async (req: Request, res: Response) => {
  const sess = getSession(req);
  const wait = sess.lastIssueMs + ISSUE_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `cooling down — try again in ${Math.ceil(wait / 1000)}s` });
  sess.lastIssueMs = Date.now();
  try {
    const count = Math.min(Number(req.body?.count ?? 3), 5);
    sess.periodSec = Math.max(8, Math.min(120, Number(req.body?.periodSec ?? 15)));
    const c = client();
    const topicId = await createTopic(c, "notyet-dash");
    const master = newMasterViewSecret();
    const now = Date.now();
    const periods: PeriodState[] = [];
    for (let i = 0; i < count; i++) {
      // first period unlocks in ~8s, each next one staggers by the cadence (so a short
      // demo cadence like 8s plays out as 8s / 16s / 24s — clean for the video)
      const round = roundForTime(now + 8_000 + i * sess.periodSec * 1000);
      const unlockMs = roundUnlockMs(round);
      if (VAULT_MODE) {
        // no per-period account: generate the key, commit its ADDRESS + policy to the vault,
        // timelock the key, post the ciphertext to HCS. The vault is the budget authority.
        const k = generatePrivateKey(); // 0x-prefixed ECDSA key
        const ciphertext = await encryptToRound(k.slice(2), round);
        const vaultIndex = vaultSeq++; // globally unique — no collision across concurrent sessions
        const start = Math.floor(unlockMs / 1000) - 5; // window opens ~at the round
        await commitPeriod(c, VAULT_ID!, {
          i: vaultIndex, signerEvm: evmAddressOf(k), budgetTinybar: PERIOD_BUDGET,
          start, end: start + 86_400, perTxMaxTinybar: PERIOD_PERTXMAX,
        });
        await submitMessage(c, topicId, JSON.stringify({ index: i, vaultIndex, round, ciphertext }));
        periods.push({ index: i, vaultIndex, round, unlockMs, ciphertext, spent: 0n });
      } else {
        const p = await issuePeriod(c, { index: i, round, budgetTinybars: "3000000" });
        await submitMessage(c, topicId, JSON.stringify({ index: i, round, accountId: p.accountId, ciphertext: p.ciphertext }));
        periods.push({ index: i, round, unlockMs, accountId: p.accountId, ciphertext: p.ciphertext, spent: 0n });
      }
    }
    c.close();
    sess.topicId = topicId;
    sess.vaultId = VAULT_MODE ? VAULT_ID : undefined;
    sess.masterView = master;
    sess.periods = periods;
    res.json({ topicId, vaultId: sess.vaultId, mode: VAULT_MODE ? "vault" : "accounts", count, periods: periods.map(({ ciphertext, spent, ...p }) => p) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status", (req: Request, res: Response) => {
  const sess = getSession(req);
  const now = Date.now();
  res.json({
    topicId: sess.topicId,
    vaultId: sess.vaultId,
    mode: sess.vaultId ? "vault" : "accounts",
    periods: sess.periods.map((p) => {
      // in vault mode the on-chain artifact is the vault contract + committed period index
      const label = sess.vaultId ? `${sess.vaultId} · #${p.vaultIndex}` : p.accountId;
      const link = sess.vaultId
        ? `https://hashscan.io/testnet/contract/${sess.vaultId}`
        : `https://hashscan.io/testnet/account/${p.accountId}`;
      return {
        index: p.index,
        round: p.round,
        accountId: label,
        hashscanAccount: link,
        state: p.paid ? "paid" : now >= p.unlockMs ? "ready" : "locked",
        secondsToUnlock: Math.max(0, Math.round((p.unlockMs - now) / 1000)),
        paid: p.paid,
      };
    }),
  });
});

app.post("/api/pay", async (req: Request, res: Response) => {
  const sess = getSession(req);
  const p = sess.periods.find((x) => x.index === Number(req.body?.index));
  if (!p) return res.status(404).json({ error: "no such period" });
  try {
    // decrypt the period key — throws NOT_YET before its drand round (the money shot)
    const key = (await decryptCiphertext(p.ciphertext)).toString("utf8");
    let withdrawHashscan: string | undefined;
    let payer: { accountId: string; privateKey: string };
    if (VAULT_MODE) {
      // sign a withdraw with the unlocked key; the vault enforces window + ecrecover + budget
      // (+ perTxMax escalation) on-chain, releasing funds into the fixed agent account
      const c = client();
      const sig = await signWithdraw(key, {
        contractEvm: VAULT_EVM, chainId: HEDERA_TESTNET_CHAINID,
        i: p.vaultIndex!, amtTinybar: WITHDRAW_TINYBAR, spentTinybar: p.spent, tag: "agent",
      });
      await withdraw(c, VAULT_ID!, { i: p.vaultIndex!, amtTinybar: WITHDRAW_TINYBAR, agent: sig });
      c.close();
      p.spent += WITHDRAW_TINYBAR;
      withdrawHashscan = `https://hashscan.io/testnet/contract/${VAULT_ID}`;
      payer = { accountId: AGENT_ID, privateKey: AGENT_KEY }; // pays x402 from the released funds
    } else {
      payer = { accountId: p.accountId!, privateKey: key }; // fallback: pay straight from the period account
    }
    const result = await payX402(SERVICE_URL, payer);
    if (result.paid && sess.topicId && sess.masterView) {
      const receipt: Receipt = { periodIndex: p.index, service: "price", amount: "100000", timestampMs: Date.now(), resultHash: "demo" };
      await submitMessage(client(), sess.topicId, encryptReceipt(receipt, deriveViewKey(sess.masterView, p.index)));
      p.paid = { tx: result.settlement!, hashscan: result.hashscan, data: result.data };
    }
    res.json({ paid: result.paid, withdraw: withdrawHashscan, ...p.paid });
  } catch (e: any) {
    res.json({ paid: false, notYet: isNotYet(e), error: isNotYet(e) ? `NOT_YET — key for period ${p.index + 1} does not exist until round ${p.round}` : e.message });
  }
});

app.post("/api/audit", async (req: Request, res: Response) => {
  const sess = getSession(req);
  if (!sess.topicId || !sess.masterView) return res.status(400).json({ error: "no active schedule" });
  const index = Number(req.body?.index);
  try {
    const viewKey = deriveViewKey(sess.masterView, index);
    const msgs = await readMessages(sess.topicId);
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
        decryptReceipt(m.contents, deriveViewKey(sess.masterView, index + 1));
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
  const sess = getSession(req);
  const wait = sess.lastSchedMs + ISSUE_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `cooling down — try again in ${Math.ceil(wait / 1000)}s` });
  sess.lastSchedMs = Date.now();
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
    sess.sched = { scheduleId, scheduledTxId, round, unlockMs: roundUnlockMs(round), accountId: p.accountId, ciphertext: p.ciphertext, tinybars };
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

app.get("/api/schedule/status", async (req: Request, res: Response) => {
  const sess = getSession(req);
  const sched = sess.sched;
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

app.post("/api/schedule/execute", async (req: Request, res: Response) => {
  const sess = getSession(req);
  const sched = sess.sched;
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
