/**
 * Day-1 gate — the tests Notyet must pass before anything else is worth building.
 *
 *   #1 tlock roundtrip: encrypt a key to a near-future drand round, prove decrypt
 *      THROWS before the round exists, wait, then prove it succeeds.
 *
 *   #2a decrypted-key settlement: timelock the Hedera payer key, decrypt it after
 *      the round, then use ONLY the decrypted key to sign a real testnet transfer.
 *      Proves the whole thesis: a key that did not exist a moment ago pays on-chain.
 *      (Full x402/Blocky402 handshake is gate #2b, added once creds are live.)
 *
 * Run: npm run gate                 (default 30s offset)
 *      GATE_OFFSET_SEC=20 npm run gate
 * Gate #2a is skipped unless HEDERA_PAYER_ID / HEDERA_PAYER_KEY are set in .env.
 */
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  Hbar,
  TransferTransaction,
} from "@x402/hedera";
import {
  encryptToRound,
  decryptCiphertext,
  roundForTime,
  roundUnlockMs,
  isNotYet,
  CHAIN_HASH,
  ROUND_PERIOD_SEC,
} from "../sdk/tlock.js";

const OFFSET_SEC = Number(process.env.GATE_OFFSET_SEC ?? 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (step: string, msg: string) => console.log(`[gate:${step}] ${msg}`);

async function gate1TlockRoundtrip(): Promise<boolean> {
  log("1", `tlock roundtrip — chain ${CHAIN_HASH.slice(0, 12)}… (${ROUND_PERIOD_SEC}s rounds)`);
  const secret = `notyet-spend-key-${OFFSET_SEC}s`;

  const round = roundForTime(Date.now() + OFFSET_SEC * 1000);
  const unlockAt = roundUnlockMs(round);
  log("1", `target round ${round}, unlocks ~${Math.round((unlockAt - Date.now()) / 1000)}s from now`);

  const ct = await encryptToRound(secret, round);
  log("1", `encrypted → ${ct.length} bytes armored`);

  try {
    await decryptCiphertext(ct);
    log("1", "FAIL: decrypt succeeded before the round");
    return false;
  } catch (err) {
    if (!isNotYet(err)) {
      log("1", `FAIL: unexpected error before round — ${(err as Error).message.split("\n")[0]}`);
      return false;
    }
    log("1", `NOT_YET (expected): ${(err as Error).message.split("\n")[0]}`);
  }

  const waitMs = Math.max(0, unlockAt - Date.now()) + 4000;
  log("1", `waiting ${Math.round(waitMs / 1000)}s for round ${round}…`);
  await sleep(waitMs);

  const out = await decryptCiphertext(ct);
  const ok = out.toString("utf8") === secret;
  log("1", ok ? `PASS: recovered secret matches` : `FAIL: mismatch (${out.toString("utf8")})`);
  return ok;
}

async function gate2aDecryptedKeySettlement(): Promise<boolean | "skip"> {
  const payerId = process.env.HEDERA_PAYER_ID;
  const payerKey = process.env.HEDERA_PAYER_KEY;
  const merchantId = process.env.HEDERA_MERCHANT_ID || payerId;
  if (!payerId || !payerKey || payerId.includes("xxx")) {
    log("2a", "skip: set HEDERA_PAYER_ID / HEDERA_PAYER_KEY in .env to run");
    return "skip";
  }

  // Timelock the REAL payer key, then recover it only after the round.
  const round = roundForTime(Date.now() + OFFSET_SEC * 1000);
  const unlockAt = roundUnlockMs(round);
  log("2a", `timelocking the Hedera payer key to round ${round}…`);
  const ct = await encryptToRound(payerKey, round);

  const waitMs = Math.max(0, unlockAt - Date.now()) + 4000;
  log("2a", `waiting ${Math.round(waitMs / 1000)}s for the key to exist…`);
  await sleep(waitMs);
  const recoveredKey = (await decryptCiphertext(ct)).toString("utf8");
  log("2a", "key decrypted — signing a testnet transfer with it");

  // Use ONLY the decrypted key to sign a real transfer.
  const key = PrivateKey.fromStringECDSA(recoveredKey.replace(/^0x/, ""));
  const client = Client.forTestnet().setOperator(AccountId.fromString(payerId), key);
  try {
    const tinybars = 100_000; // 0.001 HBAR — enough to prove settlement
    const tx = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(payerId), Hbar.fromTinybars(-tinybars))
      .addHbarTransfer(AccountId.fromString(merchantId!), Hbar.fromTinybars(tinybars))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const txId = tx.transactionId.toString();
    log("2a", `PASS: settled ${receipt.status.toString()} — ${txId}`);
    log("2a", `HashScan: https://hashscan.io/testnet/transaction/${txId}`);
    return true;
  } catch (err) {
    log("2a", `FAIL: settlement error — ${(err as Error).message.split("\n")[0]}`);
    return false;
  } finally {
    client.close();
  }
}

async function main() {
  const results: Record<string, boolean | "skip"> = {};
  results["1-tlock"] = await gate1TlockRoundtrip();
  results["2a-settlement"] = await gate2aDecryptedKeySettlement();

  console.log("\n=== gate summary ===");
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${v === "skip" ? "SKIP" : v ? "PASS" : "FAIL"}  ${k}`);
  }
  const failed = Object.values(results).some((v) => v === false);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("gate crashed:", e);
  process.exit(1);
});
