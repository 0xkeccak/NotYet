/**
 * Notyet SDK — the public, dependency-light surface any agent or client imports.
 *
 *   npm i @keccak002/notyet
 *   import { resolveSchedule, decryptCiphertext, payX402 } from "@keccak002/notyet";
 *
 * This is the published npm package: the timelock primitive (drand/tlock), Hedera money +
 * HCS log, the on-chain PeriodVault, scoped-audit receipts, schedule signing, and the agent
 * resolver. The optional on-device Ledger signing path (issuer/ledger.ts) ships in the repo,
 * not this package — it needs the Ledger Device Management Kit plus a device/emulator.
 */

// The timelock primitive (drand/tlock)
export {
  encryptToRound,
  decryptCiphertext,
  roundForTime,
  roundUnlockMs,
  isNotYet,
  CHAIN_HASH,
  ROUND_PERIOD_SEC,
} from "./tlock.js";

// Timed secret release — seal any secret (API key, credential, token) to a future time
export {
  sealSecret,
  openSecret,
  secretStatus,
  NotYetError,
  type SealedSecret,
} from "./secrets.js";

// Hedera x402 payment + HCS log
export { payX402, type SpendCredentials, type PayResult } from "./pay.js";
export { createTopic, submitMessage, readMessages, type TopicMessage } from "./hcs.js";

// PeriodVault — the on-chain treasury + timelock gate (deploy · commit · deposit · withdraw)
export {
  deployVault,
  commitPeriod,
  deposit,
  signWithdraw,
  withdraw,
  reclaim,
  evmAddressOf,
  HEDERA_TESTNET_CHAINID,
  type WithdrawSig,
} from "./vault.js";

// Scoped-audit receipts (symmetric + device-born sealed) + schedule signing
export { encryptReceipt, decryptReceipt, sealReceipt, openSealedReceipt } from "./receipts.js";
export { signSchedule, verifySchedule, issuerAddress } from "./sign.js";

// Shared types
export type { Schedule, Period, SignedSchedule, Receipt } from "./types.js";

// Issuer building blocks (no on-device signing)
export { buildSchedule, currentPeriodIndex, canonicalJSON } from "../issuer/schedule.js";
export { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
export { issuePeriod, type IssuedPeriod } from "../issuer/lock.js";
export { publishSchedule, SCHEDULE_MSG_TYPE } from "../issuer/publish.js";

// Agent building block: verify + resolve a schedule against the trusted issuer
export { resolveSchedule, UntrustedScheduleError } from "../agent/resolve.js";
