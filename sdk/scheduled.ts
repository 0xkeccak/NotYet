/**
 * Hedera Scheduled Transactions (HIP-423) — the "sign-on-unlock" settlement mode.
 *
 * A ScheduleCreate wraps an inner HBAR transfer FROM a period account TO the merchant
 * and is posted *pending, with no signature*. It sits on-chain, publicly visible, but
 * INERT — it cannot execute, because the transfer debits the period account and that
 * account's key has not signed. That key is the timelocked spend key: it does not exist
 * until its drand round. When the round arrives the agent decrypts the key and submits a
 * ScheduleSign; only then does Hedera execute the transfer.
 *
 * This is the honest way to use a native scheduled transaction without breaking the
 * thesis: we schedule the *key*, not a pre-signed transaction. Nothing can fire early
 * because the one required signature literally does not exist before its time.
 */
import {
  Client,
  AccountId,
  Hbar,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleSignTransaction,
  Timestamp,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const MIRROR: Record<string, string> = {
  "hedera:testnet": "https://testnet.mirrornode.hedera.com",
  "hedera:mainnet": "https://mainnet.mirrornode.hedera.com",
};

/**
 * Create a pending scheduled transfer (from → to). Signed by the operator (who pays the
 * schedule + the eventual execution fee), but NOT by the sending account — so it stays
 * pending until that account's key signs. Returns the schedule id and the deterministic
 * id the inner transfer will carry once it executes.
 */
export async function createScheduledTransfer(
  client: Client,
  params: { fromAccountId: string; toAccountId: string; tinybars: number; expirationSec: number },
): Promise<{ scheduleId: string; scheduledTxId: string }> {
  const transfer = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(params.fromAccountId), Hbar.fromTinybars(-params.tinybars))
    .addHbarTransfer(AccountId.fromString(params.toAccountId), Hbar.fromTinybars(params.tinybars));

  const resp = await new ScheduleCreateTransaction()
    .setScheduledTransaction(transfer)
    .setScheduleMemo("notyet:scheduled-transfer")
    .setExpirationTime(new Timestamp(Math.floor(Date.now() / 1000) + params.expirationSec, 0))
    .setWaitForExpiry(false) // execute the instant the last required signature lands
    .execute(client);

  const receipt = await resp.getReceipt(client);
  return {
    scheduleId: receipt.scheduleId!.toString(),
    scheduledTxId: receipt.scheduledTransactionId!.toString(),
  };
}

/**
 * Add the sending account's signature to a pending schedule using the (now-unlocked)
 * spend key. With wait_for_expiry=false this triggers execution immediately. Throws if
 * the schedule already executed or the key is wrong.
 */
export async function signScheduled(client: Client, scheduleId: string, spendKeyRaw: string): Promise<string> {
  const key = PrivateKey.fromStringECDSA(spendKeyRaw.replace(/^0x/, ""));
  const frozen = await new ScheduleSignTransaction().setScheduleId(scheduleId).freezeWith(client).sign(key);
  const resp = await frozen.execute(client);
  const receipt = await resp.getReceipt(client);
  return receipt.status.toString();
}

/** Read a schedule's execution state from the mirror node (no key needed to read). */
export async function scheduleStatus(
  scheduleId: string,
  network = "hedera:testnet",
): Promise<{ executed: boolean; executedTimestamp?: string; deleted?: boolean }> {
  const base = MIRROR[network] ?? MIRROR["hedera:testnet"];
  const res = await fetch(`${base}/api/v1/schedules/${scheduleId}`);
  if (!res.ok) return { executed: false };
  const j: any = await res.json();
  return { executed: !!j.executed_timestamp, executedTimestamp: j.executed_timestamp, deleted: !!j.deleted };
}

/** `0.0.5678@1789012345.123456789` → HashScan transaction URL form. */
export function txIdToHashscan(id: string, network = "hedera:testnet"): string {
  const net = network === "hedera:mainnet" ? "mainnet" : "testnet";
  const path = id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `https://hashscan.io/${net}/transaction/${path}`;
}
