/**
 * Day-1 gate — the tests Notyet must pass before anything else is worth building.
 *
 *   #1 tlock roundtrip: encrypt a key to a near-future drand round, prove decrypt
 *      THROWS before the round exists, wait, then prove it succeeds.
 *
 * More gates (x402 payment via Blocky402) are added as separate steps.
 *
 * Run: npm run gate            (default 30s offset)
 *      GATE_OFFSET_SEC=20 npm run gate
 */
import {
  mainnetClient,
  timelockEncrypt,
  timelockDecrypt,
  roundAt,
  roundTime,
  defaultChainInfo,
  Buffer as TlockBuffer,
} from "tlock-js";

const OFFSET_SEC = Number(process.env.GATE_OFFSET_SEC ?? 30);

function log(step: string, msg: string) {
  console.log(`[gate:${step}] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gate1TlockRoundtrip(): Promise<boolean> {
  log("1", `tlock roundtrip — chain ${defaultChainInfo.hash.slice(0, 12)}… (${defaultChainInfo.period}s rounds)`);
  const client = mainnetClient();

  // The "spend key" we are pretending to timelock.
  const secret = `notyet-spend-key-${OFFSET_SEC}s`;
  const payload = TlockBuffer.from(secret, "utf8");

  // Target a round OFFSET_SEC in the future.
  const targetTime = Date.now() + OFFSET_SEC * 1000;
  const round = roundAt(targetTime, defaultChainInfo);
  const unlockAt = roundTime(defaultChainInfo, round); // ms
  log("1", `target round ${round}, unlocks at ${new Date(unlockAt).toISOString()} (~${Math.round((unlockAt - Date.now()) / 1000)}s)`);

  const ciphertext = await timelockEncrypt(round, payload, client);
  log("1", `encrypted → ${ciphertext.length} bytes of armored ciphertext`);

  // Attempt 1: BEFORE the round. Must throw — the decryption key does not exist yet.
  let threwEarly = false;
  try {
    await timelockDecrypt(ciphertext, client);
    log("1", "FAIL: decrypt succeeded before the round — key existed early");
  } catch (err) {
    threwEarly = true;
    log("1", `NOT_YET (expected): ${(err as Error).message.split("\n")[0]}`);
  }
  if (!threwEarly) return false;

  // Wait for the round to pass, plus a small margin for beacon propagation.
  const waitMs = Math.max(0, unlockAt - Date.now()) + 4000;
  log("1", `waiting ${Math.round(waitMs / 1000)}s for round ${round} to be published…`);
  await sleep(waitMs);

  // Attempt 2: AFTER the round. Must succeed and match.
  try {
    const out = await timelockDecrypt(ciphertext, client);
    const recovered = out.toString("utf8");
    if (recovered === secret) {
      log("1", `PASS: decrypted after round, recovered secret matches (${recovered})`);
      return true;
    }
    log("1", `FAIL: decrypted but mismatch — got "${recovered}"`);
    return false;
  } catch (err) {
    log("1", `FAIL: decrypt threw after the round — ${(err as Error).message.split("\n")[0]}`);
    return false;
  }
}

async function main() {
  const results: Record<string, boolean> = {};
  results["1-tlock"] = await gate1TlockRoundtrip();

  console.log("\n=== gate summary ===");
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
  }
  const allPass = Object.values(results).every(Boolean);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("gate crashed:", e);
  process.exit(1);
});
