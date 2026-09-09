/**
 * Key derivation for the issuer.
 *
 * - View keys (v_i) are HKDF-derived from a master view secret, per period index.
 *   Deterministic → the owner can later re-derive one period's view key for a scoped
 *   audit without storing anything.
 * - Spend keys (k_i) are NOT derived here: each is a fresh random Hedera keypair whose
 *   private half is immediately timelock-encrypted and wiped. See issuer/lock.ts.
 */
import { hkdfSync, randomBytes } from "node:crypto";

/** Deterministic 32-byte view key for a period, from the master view secret. */
export function deriveViewKey(masterViewSecret: Buffer, periodIndex: number): Buffer {
  const info = Buffer.from(`notyet:view:${periodIndex}`, "utf8");
  const salt = Buffer.from("notyet:view", "utf8");
  return Buffer.from(hkdfSync("sha256", masterViewSecret, salt, info, 32));
}

/** A fresh random master view secret (kept by the owner; used only to derive view keys). */
export function newMasterViewSecret(): Buffer {
  return randomBytes(32);
}
