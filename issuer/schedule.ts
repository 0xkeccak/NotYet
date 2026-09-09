/**
 * Build a Notyet schedule: N periods, each with its start time and the drand round
 * that unlocks it. Pure and deterministic given the inputs — no network, no keys.
 */
import { roundForTime } from "../sdk/tlock.js";
import type { Schedule, Period } from "../sdk/types.js";

export interface ScheduleParams {
  ensName: string;
  network: string; // "hedera:testnet"
  asset: string; // "0.0.0" (HBAR tinybars) or HTS token id
  issuerPubKey: string;
  periodCount: number;
  periodLengthSec: number;
  /** Wall-clock ms of period 0's start. Defaults to now. */
  startMs?: number;
  /** Per-period budget in the asset's smallest units. Scalar → same for all. */
  budget: string | string[];
  hcsTopicId?: string;
}

export function buildSchedule(p: ScheduleParams): Schedule {
  const start = p.startMs ?? Date.now();
  const periods: Period[] = [];
  for (let i = 0; i < p.periodCount; i++) {
    const startMs = start + i * p.periodLengthSec * 1000;
    periods.push({
      index: i,
      startMs,
      round: roundForTime(startMs),
      budget: Array.isArray(p.budget) ? p.budget[i] : p.budget,
    });
  }
  return {
    ensName: p.ensName,
    network: p.network,
    asset: p.asset,
    hcsTopicId: p.hcsTopicId,
    issuerPubKey: p.issuerPubKey,
    periods,
    createdMs: start,
  };
}

/** Which period index is live at `nowMs` (or -1 before the first / after the last). */
export function currentPeriodIndex(schedule: Schedule, nowMs: number, periodLengthSec: number): number {
  for (let i = schedule.periods.length - 1; i >= 0; i--) {
    const end = schedule.periods[i].startMs + periodLengthSec * 1000;
    if (nowMs >= schedule.periods[i].startMs && nowMs < end) return i;
  }
  return -1;
}

/** Stable stringification for signing/verifying — keys sorted at every level. */
export function canonicalJSON(schedule: Schedule): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(schedule));
}
