/**
 * Agent side: resolve the schedule from Hedera (HCS) and verify it before doing anything.
 * The trust anchor is the issuer address the agent was configured to trust: if the latest
 * schedule on the topic isn't signed by that issuer, the agent refuses — no schedule, no
 * spending. (This is the role ENS used to play; it's now the same Hedera log that carries
 * everything else — one chain, no bridge.)
 */
import { readMessages } from "../sdk/hcs.js";
import { verifySchedule } from "../sdk/sign.js";
import { SCHEDULE_MSG_TYPE } from "../issuer/publish.js";
import type { SignedSchedule, Schedule } from "../sdk/types.js";

export class UntrustedScheduleError extends Error {}

/**
 * Read the latest signed schedule from an HCS topic and verify it against `expectedIssuer`.
 * Throws UntrustedScheduleError if none is found, the issuer doesn't match, or the
 * signature doesn't verify.
 */
export async function resolveSchedule(
  topicId: string,
  expectedIssuer: string,
  network = "hedera:testnet",
): Promise<Schedule> {
  const msgs = await readMessages(topicId, network);

  // Take the most recent notyet:schedule message on the topic.
  let signed: SignedSchedule | undefined;
  for (const m of msgs) {
    try {
      const parsed = JSON.parse(m.contents);
      if (parsed?.type === SCHEDULE_MSG_TYPE && parsed.signed) signed = parsed.signed as SignedSchedule;
    } catch {
      // not a schedule message (a ciphertext or receipt) — skip
    }
  }
  if (!signed) throw new UntrustedScheduleError(`no ${SCHEDULE_MSG_TYPE} message on topic ${topicId}`);

  // Trust anchor: the schedule must be signed by the issuer the agent was told to trust…
  if (signed.schedule.issuerPubKey.toLowerCase() !== expectedIssuer.toLowerCase()) {
    throw new UntrustedScheduleError(`issuer mismatch: schedule issuer ${signed.schedule.issuerPubKey} != expected ${expectedIssuer}`);
  }
  // …and the signature must verify against it.
  if (!(await verifySchedule(signed))) {
    throw new UntrustedScheduleError(`schedule signature does not verify for issuer ${signed.schedule.issuerPubKey}`);
  }
  return signed.schedule;
}
