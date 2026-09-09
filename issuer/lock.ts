/**
 * Issue one period: create a fresh Hedera account keyed to a new spend key, fund it
 * with that period's budget, timelock-encrypt the spend key to the period's drand
 * round, and wipe the plaintext. The private key exists in this process only long
 * enough to encrypt it — the returned ciphertext is the only copy, and it cannot be
 * opened until the round.
 */
import { Client, PrivateKey, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";
import { encryptToRound } from "../sdk/tlock.js";

export interface IssuedPeriod {
  index: number;
  round: number;
  accountId: string;
  evmAddress: string;
  /** tlock ciphertext of the spend private key — the only copy after issuance. */
  ciphertext: string;
  budgetTinybars: string;
}

/** Create + fund a period account and timelock its spend key to `round`. */
export async function issuePeriod(
  client: Client,
  params: { index: number; round: number; budgetTinybars: string },
): Promise<IssuedPeriod> {
  const spendKey = PrivateKey.generateECDSA();
  const evmAddress = "0x" + spendKey.publicKey.toEvmAddress();

  const tx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(spendKey.publicKey)
    .setInitialBalance(Hbar.fromTinybars(params.budgetTinybars))
    .execute(client);
  const accountId = (await tx.getReceipt(client)).accountId!.toString();

  // Timelock the private key, then drop the plaintext reference.
  const ciphertext = await encryptToRound(spendKey.toStringRaw(), params.round);

  return {
    index: params.index,
    round: params.round,
    accountId,
    evmAddress,
    ciphertext,
    budgetTinybars: params.budgetTinybars,
  };
}
