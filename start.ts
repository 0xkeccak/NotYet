/**
 * Single-process entry for hosting (Railway): starts the x402 service on a fixed
 * internal port and the dashboard/landing on $PORT. The dashboard talks to the
 * service over localhost. Ledger (Speculos) is a local issuer-side step and is not
 * part of the hosted surface.
 */
import "dotenv/config";

process.env.SERVICE_PORT = process.env.SERVICE_PORT ?? "4021";
process.env.SERVICE_URL = process.env.SERVICE_URL ?? `http://localhost:${process.env.SERVICE_PORT}/price`;

// Side-effect imports: each module starts its own express listener.
await import("./service/server.js");
await import("./web/server.js");
