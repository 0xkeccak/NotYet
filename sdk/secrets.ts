/**
 * Timed secret release — the same timelock that hides a spend key hides any secret.
 *
 * A spend key is just one thing you can seal to a future time. `sealSecret` takes an
 * arbitrary value — an API key, a database credential, an OAuth token, a signing key —
 * and returns a ciphertext that literally cannot be opened until its unlock time: not
 * by the agent holding it, not by the issuer, not by drand itself. Hand an agent the
 * sealed secret up front and it still gets nothing until the moment you scheduled.
 *
 *   const sealed = await sealSecret(process.env.STRIPE_KEY, Date.parse("2026-09-15T09:00:00Z"), "stripe");
 *   // give `sealed` to the agent now …
 *   const key = await openSecret(sealed);   // throws NOT_YET before 09:00, returns the key after
 *
 * This is the honeypot-free alternative to a secrets vault that streams keys just-in-time:
 * there is no server holding the plaintext to breach or coerce, and a leaked ciphertext is
 * useless until its time and useless to anyone for any period but its own.
 */
import { encryptToRound, decryptCiphertext, roundForTime, roundUnlockMs, isNotYet } from "./tlock.js";

/** A secret sealed to a future unlock time. Safe to hand out — it is only ciphertext. */
export interface SealedSecret {
  /** Caller-chosen name for the secret (e.g. "stripe", "openai"). Not encrypted. */
  label: string;
  /** drand round the secret unlocks at. */
  round: number;
  /** Wall-clock ms at which the secret becomes openable. */
  unlockAtMs: number;
  /** The timelock ciphertext — the only copy of the secret after sealing. */
  ciphertext: string;
}

/** Thrown by `openSecret` when the secret's unlock time has not arrived yet. */
export class NotYetError extends Error {
  constructor(
    readonly label: string,
    readonly round: number,
    readonly unlockAtMs: number,
  ) {
    const secs = Math.max(0, Math.ceil((unlockAtMs - nowMs()) / 1000));
    super(`NOT_YET — secret "${label}" does not exist until round ${round} (~${secs}s away)`);
    this.name = "NotYetError";
  }
}

/**
 * Seal `secret` so it can only be opened at (or after) `unlockAtMs`. The plaintext is
 * used only to encrypt and is not retained — the returned `SealedSecret` is the only copy.
 */
export async function sealSecret(
  secret: string,
  unlockAtMs: number,
  label = "secret",
): Promise<SealedSecret> {
  const round = roundForTime(unlockAtMs);
  const ciphertext = await encryptToRound(secret, round);
  return { label, round, unlockAtMs: roundUnlockMs(round), ciphertext };
}

/**
 * Open a sealed secret. Returns the plaintext once its round has been published; throws
 * `NotYetError` if it is still too early. Any other decryption failure is re-thrown as-is.
 */
export async function openSecret(sealed: SealedSecret): Promise<string> {
  try {
    const plain = await decryptCiphertext(sealed.ciphertext);
    return plain.toString("utf8");
  } catch (err) {
    if (isNotYet(err)) throw new NotYetError(sealed.label, sealed.round, sealed.unlockAtMs);
    throw err;
  }
}

/** Non-throwing status check: whether the secret is openable yet, and how long until it is. */
export function secretStatus(sealed: SealedSecret): {
  unlocked: boolean;
  unlockAtMs: number;
  secondsRemaining: number;
} {
  const remaining = Math.max(0, Math.ceil((sealed.unlockAtMs - nowMs()) / 1000));
  return { unlocked: remaining === 0, unlockAtMs: sealed.unlockAtMs, secondsRemaining: remaining };
}

function nowMs(): number {
  return Date.now();
}
