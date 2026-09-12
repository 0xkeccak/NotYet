/**
 * Notyet SDK — the public surface any agent or client imports.
 *
 *   import { resolveSchedule, decryptCiphertext, payX402 } from "notyet";
 *
 * Grouped: timelock (the primitive), Hedera (money + log + root of trust),
 * receipts (scoped audit), and the issuer/agent building blocks.
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

// PeriodVault — optional Ledger-as-owner path: deploy/commit signed on the device through
// the Hedera JSON-RPC relay, so on-chain owner == approver == the Ledger (one identity).
export {
  hederaRelayClient,
  deployVaultViaRelay,
  commitPeriodViaRelay,
  HEDERA_RELAY_URL,
} from "./vault-relay.js";

// Scoped-audit receipts (symmetric + device-born sealed) + schedule signing
export { encryptReceipt, decryptReceipt, sealReceipt, openSealedReceipt } from "./receipts.js";
export { signSchedule, verifySchedule, issuerAddress } from "./sign.js";

// Shared types
export type { Schedule, Period, SignedSchedule, Receipt } from "./types.js";

// Issuer building blocks
export { buildSchedule, currentPeriodIndex, canonicalJSON } from "../issuer/schedule.js";
export { deriveViewKey, newMasterViewSecret } from "../issuer/derive.js";
export { issuePeriod, type IssuedPeriod } from "../issuer/lock.js";
export { publishSchedule, SCHEDULE_MSG_TYPE } from "../issuer/publish.js";
export {
  signScheduleWithLedger,
  ledgerIssuerAddress,
  ledgerApproveWithdraw,
  ledgerViewKeyPair,
  type LedgerOptions,
} from "../issuer/ledger.js";

// Agent building blocks
export { resolveSchedule, UntrustedScheduleError } from "../agent/resolve.js";
