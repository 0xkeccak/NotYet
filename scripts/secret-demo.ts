/**
 * Timed secret release, end to end — the "not just payments" money shot.
 *
 *   npm run secret-demo
 *
 * Seals an API key to ~30s in the future, proves it reads NOT_YET while the agent
 * already holds the ciphertext, waits for the real drand round, then opens it.
 */
import { sealSecret, openSecret, secretStatus } from "../sdk/secrets.js";

const API_KEY = "sk-live-notyet-DO-NOT-SHIP-a1b2c3d4e5f6";

async function main() {
  const unlockAtMs = Date.now() + 30_000;
  console.log(`\nSealing an API key to unlock at ${new Date(unlockAtMs).toISOString()} …`);
  const sealed = await sealSecret(API_KEY, unlockAtMs, "openai");
  console.log(`✓ sealed "${sealed.label}" → round ${sealed.round}. The agent holds only this ciphertext:`);
  console.log(`  ${sealed.ciphertext.slice(0, 64).replace(/\n/g, " ")}…\n`);

  // The agent has the sealed secret NOW — but it does not exist in usable form yet.
  try {
    await openSecret(sealed);
    console.log("!! opened early — this should not happen");
  } catch (err) {
    console.log(`✓ tried early → ${(err as Error).message}`);
  }

  // Wait for the real beacon round.
  let s = secretStatus(sealed);
  while (!s.unlocked) {
    process.stdout.write(`  waiting for the beacon … ${s.secondsRemaining}s\r`);
    await sleep(3000);
    s = secretStatus(sealed);
  }

  const key = await openSecret(sealed);
  console.log(`\n✓ round reached → key released: ${key}`);
  console.log("  Same lock, any secret — an API key, a credential, a token. No key server.\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
