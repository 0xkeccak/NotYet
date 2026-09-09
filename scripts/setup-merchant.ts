/**
 * One-off: use the funded payer account as operator to create a MERCHANT account
 * (the x402 service's payTo). Avoids a second faucet captcha. Writes the merchant
 * id/key into .env. Run once: npx tsx scripts/setup-merchant.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Client, PrivateKey, AccountId, Hbar, AccountCreateTransaction } from "@hiero-ledger/sdk";

const payerId = process.env.HEDERA_PAYER_ID!;
const payerKey = process.env.HEDERA_PAYER_KEY!;
if (!payerId || !payerKey) throw new Error("HEDERA_PAYER_ID / HEDERA_PAYER_KEY missing");

const operatorKey = PrivateKey.fromStringECDSA(payerKey.replace(/^0x/, ""));
const client = Client.forTestnet().setOperator(AccountId.fromString(payerId), operatorKey);

const merchantKey = PrivateKey.generateECDSA();
const tx = await new AccountCreateTransaction()
  .setKeyWithoutAlias(merchantKey.publicKey)
  .setInitialBalance(new Hbar(1))
  .execute(client);
const receipt = await tx.getReceipt(client);
const merchantId = receipt.accountId!.toString();

let e = readFileSync(".env", "utf8");
e = e.replace(/HEDERA_MERCHANT_ID=.*/, `HEDERA_MERCHANT_ID=${merchantId}`);
if (!/HEDERA_MERCHANT_KEY=/.test(e)) e += `\nHEDERA_MERCHANT_KEY=0x${merchantKey.toStringRaw()}\n`;
else e = e.replace(/HEDERA_MERCHANT_KEY=.*/, `HEDERA_MERCHANT_KEY=0x${merchantKey.toStringRaw()}`);
writeFileSync(".env", e);

console.log("merchant account created:", merchantId);
client.close();
