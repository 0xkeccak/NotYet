/**
 * Single-process entry for hosting (Railway). The web server hosts the landing page,
 * the dashboard API, AND the real x402-gated /price service (mounted via mountX402), so
 * one public port serves everything — including a directly-callable x402 endpoint.
 */
import "dotenv/config";
await import("./web/server.js");
