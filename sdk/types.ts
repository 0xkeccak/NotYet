/** Shared Notyet types. Money is always integer smallest-units (never a float). */

export interface Period {
  /** 0-based period index. */
  index: number;
  /** Wall-clock ms when this period's authority starts (its key unlocks). */
  startMs: number;
  /** drand round whose signature decrypts this period's spend key. */
  round: number;
  /** Hedera account holding this period's budget, keyed to pub(spendKey). */
  hederaAccountId?: string;
  /** Budget for this period, in the asset's smallest units. */
  budget: string;
}

export interface Schedule {
  /** Human label / agent id (e.g. an ENS name, if used). Not load-bearing for trust. */
  agentId: string;
  /** Hedera network, e.g. "hedera:testnet". */
  network: string;
  /** Asset id: "0.0.0" for HBAR (tinybars), or an HTS token id. */
  asset: string;
  /** HCS topic carrying the signed schedule, ciphertexts + encrypted receipts (root of trust). */
  hcsTopicId?: string;
  /** Issuer (master) public key the agent verifies the schedule signature against. */
  issuerPubKey: string;
  periods: Period[];
  createdMs: number;
}

/** A schedule plus the issuer's signature over its canonical JSON. */
export interface SignedSchedule {
  schedule: Schedule;
  /** Hex signature over canonicalJSON(schedule), produced by the Ledger master key. */
  signature: string;
}

/** Encrypted per-period receipt logged to HCS (symmetric under the view key). */
export interface Receipt {
  periodIndex: number;
  service: string;
  amount: string;
  timestampMs: number;
  resultHash: string;
}
