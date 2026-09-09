/**
 * Hedera Consensus Service — the tamper-proof, time-ordered log that carries the
 * timelock ciphertexts (owner → agent) and the encrypted receipts (agent → auditor).
 *
 * Submit uses the SDK; reads use the mirror node REST API (no key needed to read).
 */
import { Client, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

const MIRROR: Record<string, string> = {
  "hedera:testnet": "https://testnet.mirrornode.hedera.com",
  "hedera:mainnet": "https://mainnet.mirrornode.hedera.com",
};

/** Create a new HCS topic. Returns the topic id (0.0.x). */
export async function createTopic(client: Client, memo = "notyet"): Promise<string> {
  const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
  const receipt = await tx.getReceipt(client);
  return receipt.topicId!.toString();
}

/** Submit one message to a topic. Returns the consensus sequence number. */
export async function submitMessage(client: Client, topicId: string, message: string): Promise<number> {
  const tx = await new TopicMessageSubmitTransaction({ topicId, message }).execute(client);
  const receipt = await tx.getReceipt(client);
  return receipt.topicSequenceNumber!.toNumber();
}

export interface TopicMessage {
  sequenceNumber: number;
  contents: string; // decoded UTF-8
  consensusTimestamp: string;
}

/**
 * Read all messages on a topic via the mirror node (base64-decoded to UTF-8).
 * Mirror indexing lags a few seconds behind consensus.
 */
export async function readMessages(topicId: string, network = "hedera:testnet"): Promise<TopicMessage[]> {
  const base = MIRROR[network] ?? MIRROR["hedera:testnet"];
  const out: TopicMessage[] = [];
  let next: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (next) {
    const res = await fetch(base + next);
    if (!res.ok) throw new Error(`mirror node ${res.status} for topic ${topicId}`);
    const json = (await res.json()) as { messages: any[]; links?: { next?: string | null } };
    for (const m of json.messages) {
      out.push({
        sequenceNumber: m.sequence_number,
        contents: Buffer.from(m.message, "base64").toString("utf8"),
        consensusTimestamp: m.consensus_timestamp,
      });
    }
    next = json.links?.next ?? null;
  }
  return out;
}
