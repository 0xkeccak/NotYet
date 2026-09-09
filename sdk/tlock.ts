/**
 * Timelock encryption over the drand quicknet beacon (52db9ba7…, 3s G1 rounds).
 *
 * This is the whole primitive: encrypt a secret to a future round; it cannot be
 * decrypted until the drand network publishes that round's signature — not by the
 * sender, not by the holder, not by drand itself.
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

export const CHAIN_HASH = defaultChainInfo.hash;
export const ROUND_PERIOD_SEC = defaultChainInfo.period;

/** The drand round that will have been published at (or just after) `atTimeMs`. */
export function roundForTime(atTimeMs: number): number {
  return roundAt(atTimeMs, defaultChainInfo);
}

/** Wall-clock ms at which `round` becomes decryptable. */
export function roundUnlockMs(round: number): number {
  return roundTime(defaultChainInfo, round);
}

/** Encrypt a secret so it can only be opened once drand publishes `round`. */
export async function encryptToRound(secret: string | Uint8Array, round: number): Promise<string> {
  const payload = typeof secret === "string" ? TlockBuffer.from(secret, "utf8") : TlockBuffer.from(secret);
  return timelockEncrypt(round, payload, mainnetClient());
}

/**
 * Decrypt a timelocked ciphertext. Throws (message contains "too early") if the
 * target round has not yet been published — this is the NOT_YET condition.
 */
export async function decryptCiphertext(ciphertext: string): Promise<Buffer> {
  return timelockDecrypt(ciphertext, mainnetClient());
}

/** True if decrypting would currently throw NOT_YET (round not yet reached). */
export function isNotYet(err: unknown): boolean {
  return err instanceof Error && /too early/i.test(err.message);
}
