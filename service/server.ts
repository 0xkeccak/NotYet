/**
 * A real x402-gated service on Hedera — the thing the Notyet agent pays for.
 *
 * GET /price returns a (mock) price feed, but only after an x402 payment settled
 * through the Blocky402 testnet facilitator. No API key, no subscription — the agent
 * pays per call with its unlocked period key.
 *
 * Run: npx tsx service/server.ts   (reads .env: HEDERA_MERCHANT_ID, BLOCKY402_URL, X402_*)
 */
import "dotenv/config";
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const PORT = Number(process.env.SERVICE_PORT ?? 4021); // fixed internal port (web takes $PORT)
const NETWORK = process.env.HEDERA_NETWORK === "mainnet" ? "hedera:mainnet" : "hedera:testnet";
const MERCHANT = process.env.HEDERA_MERCHANT_ID;
const FACILITATOR = process.env.BLOCKY402_URL ?? "https://api.testnet.blocky402.com";
const ASSET = process.env.X402_ASSET ?? "0.0.0"; // HBAR tinybars by default
// Price as an explicit asset amount (no USD conversion). HBAR: tinybars (1 HBAR = 1e8).
const AMOUNT = process.env.X402_AMOUNT ?? "100000"; // 0.001 HBAR
// HBAR is 8 decimals (tinybars); HTS tokens (e.g. USDC) are 6.
const DECIMALS = ASSET === "0.0.0" ? 8 : 6;

if (!MERCHANT || MERCHANT.includes("xxx")) {
  console.error("set HEDERA_MERCHANT_ID in .env (the account that receives payment)");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "hedera:*",
  new ExactHederaScheme({ defaultAssets: { [NETWORK]: { asset: ASSET, decimals: DECIMALS } } }),
);

const app = express();

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true, network: NETWORK, facilitator: FACILITATOR }));

app.use(
  paymentMiddleware(
    {
      "GET /price": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: MERCHANT,
          price: { asset: ASSET, amount: AMOUNT },
        },
        description: "Notyet demo price feed — pay per call, no API key.",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/price", (_req: Request, res: Response) => {
  // In a real service this is a metered resource; here it's a deterministic mock.
  res.json({ pair: "HBAR/USD", price: 0.0712, ts: new Date().toISOString(), source: "notyet-demo" });
});

app.listen(PORT, () => {
  console.log(`x402 price service on :${PORT} (${NETWORK}), payTo ${MERCHANT}, facilitator ${FACILITATOR}`);
});
