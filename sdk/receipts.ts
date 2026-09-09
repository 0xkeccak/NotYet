/**
 * Per-period encrypted receipts. The agent logs each payment as a receipt encrypted
 * under that period's view key (v_i) and posts it to HCS. Later, an auditor given only
 * v_i can decrypt that period's receipts — and nothing else.
 *
 * Symmetric authenticated encryption via NaCl secretbox (XSalsa20-Poly1305).
 */
import nacl from "tweetnacl";
import type { Receipt } from "./types.js";

/** Encrypt a receipt under a 32-byte view key → base64(nonce ‖ box). */
export function encryptReceipt(receipt: Receipt, viewKey: Uint8Array): string {
  if (viewKey.length !== 32) throw new Error("view key must be 32 bytes");
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = new TextEncoder().encode(JSON.stringify(receipt));
  const box = nacl.secretbox(message, nonce, viewKey);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce, 0);
  out.set(box, nonce.length);
  return Buffer.from(out).toString("base64");
}

/** Decrypt a receipt with the period view key. Throws if the key is wrong/tampered. */
export function decryptReceipt(ciphertextB64: string, viewKey: Uint8Array): Receipt {
  if (viewKey.length !== 32) throw new Error("view key must be 32 bytes");
  const raw = Uint8Array.from(Buffer.from(ciphertextB64, "base64"));
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const box = raw.slice(nacl.secretbox.nonceLength);
  const opened = nacl.secretbox.open(box, nonce, viewKey);
  if (!opened) throw new Error("receipt decryption failed (wrong view key or tampered)");
  return JSON.parse(new TextDecoder().decode(opened)) as Receipt;
}
