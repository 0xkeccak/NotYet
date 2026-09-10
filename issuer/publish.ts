/**
 * Publish the signed schedule to Hedera Consensus Service (HCS) — the root of trust.
 * The issuer posts the Ledger-signed schedule to a topic; the agent later reads it back
 * and verifies the signature against the issuer address it was configured to trust. No
 * ENS, no second chain: the same tamper-proof, time-ordered log that carries the timelock
 * ciphertexts also carries the rules the agent runs on.
 */
import type { Client } from "@hiero-ledger/sdk";
import { submitMessage } from "../sdk/hcs.js";
import type { SignedSchedule } from "../sdk/types.js";

export const SCHEDULE_MSG_TYPE = "notyet:schedule";

/** Post the signed schedule to an HCS topic. Returns the consensus sequence number. */
export async function publishSchedule(client: Client, topicId: string, signed: SignedSchedule): Promise<number> {
  const message = JSON.stringify({
    type: SCHEDULE_MSG_TYPE,
    issuer: signed.schedule.issuerPubKey,
    signed,
  });
  return submitMessage(client, topicId, message);
}
