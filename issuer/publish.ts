/**
 * Publish the signed schedule to ENS: the issuer address under `notyet:issuer` and the
 * signed schedule JSON under `notyet:schedule`. This is what makes the ENS name the
 * agent's root of trust — the agent reads these and verifies before acting.
 */
import { writeText, SCHEDULE_KEY, ISSUER_KEY } from "../sdk/ens.js";
import type { SignedSchedule } from "../sdk/types.js";

export async function publishSchedule(
  rpcUrl: string,
  ownerPrivateKey: `0x${string}`,
  ensName: string,
  signed: SignedSchedule,
): Promise<{ issuerTx: string; scheduleTx: string }> {
  const issuerTx = await writeText(rpcUrl, ownerPrivateKey, ensName, ISSUER_KEY, signed.schedule.issuerPubKey);
  const scheduleTx = await writeText(rpcUrl, ownerPrivateKey, ensName, SCHEDULE_KEY, JSON.stringify(signed));
  return { issuerTx, scheduleTx };
}
