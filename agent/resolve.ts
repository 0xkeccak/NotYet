/**
 * Agent side: resolve the schedule from ENS and verify it before doing anything.
 * If the signature doesn't match the issuer address published on ENS, the agent
 * refuses — no schedule, no spending.
 */
import { readText, SCHEDULE_KEY, ISSUER_KEY } from "../sdk/ens.js";
import { verifySchedule } from "../sdk/sign.js";
import type { SignedSchedule, Schedule } from "../sdk/types.js";

export class UntrustedScheduleError extends Error {}

/** Read + verify the schedule from an ENS name. Throws if missing or signature invalid. */
export async function resolveSchedule(rpcUrl: string, ensName: string): Promise<Schedule> {
  const raw = await readText(rpcUrl, ensName, SCHEDULE_KEY);
  if (!raw) throw new UntrustedScheduleError(`no ${SCHEDULE_KEY} record on ${ensName}`);

  const signed = JSON.parse(raw) as SignedSchedule;

  // The issuer address must match what's independently published on ENS…
  const issuerOnEns = await readText(rpcUrl, ensName, ISSUER_KEY);
  if (issuerOnEns.toLowerCase() !== signed.schedule.issuerPubKey.toLowerCase()) {
    throw new UntrustedScheduleError(`issuer mismatch: ${ISSUER_KEY} record != schedule.issuerPubKey`);
  }
  // …and the signature must verify against it.
  if (!(await verifySchedule(signed))) {
    throw new UntrustedScheduleError(`schedule signature does not verify for issuer ${signed.schedule.issuerPubKey}`);
  }
  return signed.schedule;
}
