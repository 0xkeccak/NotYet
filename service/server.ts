/**
 * A real x402-gated service on Hedera — the thing the Notyet agent pays for.
 *
 * GET /price returns a (mock) price feed, but only after an x402 payment settled
 * through the Blocky402 testnet facilitator. No API key, no subscription — the agent
 * pays per call with its unlocked period key.
 *
 * `mountX402(app)` attaches the gated endpoint to any Express app; the web server calls
 * it so /price is reachable on the public hosted URL (a real, callable x402 service).
 * Run standalone for local dev: npx tsx service/server.ts
 */
import "dotenv/config";
import express, { type Express, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer, setSettlementOverrides } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const PORT = Number(process.env.SERVICE_PORT ?? 4021); // standalone port (web uses $PORT)
const NETWORK = process.env.HEDERA_NETWORK === "mainnet" ? "hedera:mainnet" : "hedera:testnet";
const MERCHANT = process.env.HEDERA_MERCHANT_ID;
const FACILITATOR = process.env.BLOCKY402_URL ?? "https://api.testnet.blocky402.com";
const ASSET = process.env.X402_ASSET ?? "0.0.0"; // HBAR tinybars by default
// Price as an explicit asset amount (no USD conversion). HBAR: tinybars (1 HBAR = 1e8).
const AMOUNT = process.env.X402_AMOUNT ?? "100000"; // 0.001 HBAR
// HBAR is 8 decimals (tinybars); HTS tokens (e.g. USDC) are 6.
const DECIMALS = ASSET === "0.0.0" ? 8 : 6;

// Metering (Hedera bonus: pay-per-call, not flat). /data prices by rows returned. The 402
// challenge quotes the MAX (perRow * maxRows); the handler settles only what was consumed
// via x402 partial-settlement (setSettlementOverrides). No overcharge for a small query.
const METER_PER_ROW = Number(process.env.X402_PER_ROW ?? 2000); // tinybars per row
const METER_MAX_ROWS = Number(process.env.X402_MAX_ROWS ?? 50);
const METER_MAX = String(METER_PER_ROW * METER_MAX_ROWS);

/** Attach the x402-gated /price feed (and /health) to an existing Express app. */
export function mountX402(app: Express): void {
  if (!MERCHANT || MERCHANT.includes("xxx")) {
    throw new Error("set HEDERA_MERCHANT_ID (the account that receives payment)");
  }
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    "hedera:*",
    new ExactHederaScheme({ defaultAssets: { [NETWORK]: { asset: ASSET, decimals: DECIMALS } } }),
  );

  app.get("/health", (_req: Request, res: Response) =>
    res.json({ ok: true, network: NETWORK, facilitator: FACILITATOR, payTo: MERCHANT }),
  );

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
        "GET /data": {
          accepts: {
            scheme: "exact",
            network: NETWORK,
            payTo: MERCHANT,
            price: { asset: ASSET, amount: METER_MAX },
          },
          description: `Notyet metered feed — billed ${METER_PER_ROW} tinybars/row (max ${METER_MAX_ROWS}); only rows consumed are settled.`,
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

  // Metered resource: caller asks for N rows, pays only for N (partial settlement).
  app.get("/data", (req: Request, res: Response) => {
    const asked = Number(Array.isArray(req.query.rows) ? req.query.rows[0] : req.query.rows) || 1;
    const rows = Math.max(1, Math.min(METER_MAX_ROWS, Math.floor(asked)));
    const billed = rows * METER_PER_ROW;
    // Settle only what was consumed, not the quoted max.
    setSettlementOverrides(res, { amount: String(billed) });
    const now = Date.now();
    res.json({
      rows: Array.from({ length: rows }, (_, i) => ({ i, pair: "HBAR/USD", price: 0.0712, ts: new Date(now - i * 1000).toISOString() })),
      metering: { rows, perRowTinybars: METER_PER_ROW, billedTinybars: billed, quotedMaxTinybars: Number(METER_MAX) },
      source: "notyet-demo",
    });
  });
}

// Standalone mode (local dev): serve just the x402 service on its own port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = express();
  mountX402(app);
  app.listen(PORT, () =>
    console.log(`x402 price service on :${PORT} (${NETWORK}), payTo ${MERCHANT}, facilitator ${FACILITATOR}`),
  );
}
