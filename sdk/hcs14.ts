/**
 * HCS-14 — Universal Agent ID (UAID) for the NotYet agent.
 *
 * HCS-14 gives an AI agent one portable identifier that stays stable as its endpoints
 * change, across Web2 and Web3. We derive the `aid` form deterministically:
 *   uaid:aid:<base58(SHA-384(canonical-json(metadata)))>;uid=<uid>;proto=<p>;nativeId=<caip10>
 * with params emitted in the standard order (uid, registry, proto, nativeId, domain).
 *
 * Ref: HCS-14 (Hashgraph Online). This implements the documented aid-derivation shape
 * (SHA-384 of canonical JSON → base58) and the UAID parameter ordering. NOTE: reconcile
 * the exact canonical field set against the reference standards-sdk before final submit;
 * the derivation here is self-contained and deterministic.
 */
import { createHash } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) encoding of a byte array. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n = n / 58n;
    out = B58[r] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

/** RFC-8785-style canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export interface AgentMetadata {
  name: string;
  version: string;
  protocol: string; // e.g. "mcp", "a2a"
  nativeId: string; // CAIP-10, e.g. "hedera:testnet:0.0.10436969" or "eip155:296:0x…"
  skills: string[];
}

/** Deterministic aid = base58(SHA-384(canonical JSON of metadata)). */
export function agentAid(meta: AgentMetadata): string {
  const digest = createHash("sha384").update(canonicalize(meta), "utf8").digest();
  return base58(new Uint8Array(digest));
}

export interface UaidParams {
  uid?: string; // required by the standard; "0" if not applicable
  registry?: string;
  proto?: string;
  nativeId?: string;
  domain?: string;
}

/** Assemble a full UAID string, params in the standard order. */
export function buildUaid(target: "aid" | "did", id: string, p: UaidParams = {}): string {
  let s = `uaid:${target}:${id};uid=${p.uid ?? "0"}`;
  if (p.registry) s += `;registry=${p.registry}`;
  if (p.proto) s += `;proto=${p.proto}`;
  if (p.nativeId) s += `;nativeId=${p.nativeId}`;
  if (p.domain) s += `;domain=${p.domain}`;
  return s;
}

/** One call: metadata → full UAID (aid form). */
export function agentUaid(meta: AgentMetadata, extra: Omit<UaidParams, "nativeId"> = {}): string {
  return buildUaid("aid", agentAid(meta), { ...extra, proto: extra.proto ?? meta.protocol, nativeId: meta.nativeId });
}
