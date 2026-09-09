/**
 * Schedule signing / verification — the ENS root of trust.
 *
 * The issuer (Ledger master key) signs the canonical schedule JSON; the agent verifies
 * that signature against the issuer address published on ENS, and refuses to act if it
 * doesn't match. secp256k1 personal-sign so a Ledger device can produce it for real —
 * a software key is the stand-in until Key Ring is wired.
 */
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type Address } from "viem";
import { canonicalJSON } from "../issuer/schedule.js";
import type { Schedule, SignedSchedule } from "./types.js";

/** Sign a schedule with the issuer key. Returns { schedule, signature }. */
export async function signSchedule(schedule: Schedule, issuerPrivateKey: `0x${string}`): Promise<SignedSchedule> {
  const account = privateKeyToAccount(issuerPrivateKey);
  const signature = await account.signMessage({ message: canonicalJSON(schedule) });
  return { schedule, signature };
}

/**
 * Verify a signed schedule: recover the signer from the canonical JSON and check it
 * equals the issuer address the schedule claims (schedule.issuerPubKey).
 */
export async function verifySchedule(signed: SignedSchedule): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message: canonicalJSON(signed.schedule),
      signature: signed.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === signed.schedule.issuerPubKey.toLowerCase();
  } catch {
    return false;
  }
}

/** The issuer address (root of trust) that goes in the ENS issuer record. */
export function issuerAddress(issuerPrivateKey: `0x${string}`): Address {
  return privateKeyToAccount(issuerPrivateKey).address;
}
