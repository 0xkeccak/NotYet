/**
 * Agent-side x402 payment. Given the (freshly unlocked) Hedera spend key, pay an
 * x402-gated URL: hit it, get 402, sign the payment with the spend key, retry, and
 * return both the resource body and the on-chain settlement.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";

export interface SpendCredentials {
  accountId: string;
  /** ECDSA private key hex (with or without 0x). This is the timelock-unlocked key. */
  privateKey: string;
  network?: string; // "hedera:testnet" (default) | "hedera:mainnet"
}

export interface PayResult {
  paid: boolean;
  status: number;
  data: unknown;
  /** On-chain settlement tx id, if the facilitator returned one. */
  settlement?: string;
  hashscan?: string;
}

export async function payX402(url: string, cred: SpendCredentials): Promise<PayResult> {
  const network = cred.network ?? "hedera:testnet";
  const signer = createClientHederaSigner(
    cred.accountId,
    PrivateKey.fromStringECDSA(cred.privateKey.replace(/^0x/, "")),
    { network },
  );
  const client = new x402HTTPClient(new x402Client().register("hedera:*", new ExactHederaScheme(signer)));

  const first = await fetch(url);
  if (first.status !== 402) {
    return { paid: false, status: first.status, data: await safeJson(first) };
  }

  const required = client.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
  const payload = await client.createPaymentPayload(required);

  const paid = await fetch(url, { headers: client.encodePaymentSignatureHeader(payload) });
  const settle = client.getPaymentSettleResponse((n) => paid.headers.get(n));
  const tx = settle?.transaction;

  return {
    paid: paid.ok,
    status: paid.status,
    data: await safeJson(paid),
    settlement: tx,
    hashscan: tx ? `https://hashscan.io/${network.split(":")[1]}/transaction/${tx}` : undefined,
  };
}

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return await r.text();
  }
}
