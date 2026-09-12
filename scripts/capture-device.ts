/**
 * Capture authentic Speculos device screens during a real on-device sign, for the site's
 * Ledger card. Kicks off a DMK signMessage, captures the review frames from Speculos'
 * /screenshot, then approves via the button API. Not part of the product — a screenshot tool.
 *
 *   npx tsx scripts/capture-device.ts <outDir>
 */
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { writeFileSync } from "node:fs";

const URL_ = "http://localhost:5111";
const DERIVATION = "44'/60'/0'/0/0";
const OUT = process.argv[2] || "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(name: string) {
  const buf = Buffer.from(await (await fetch(`${URL_}/screenshot`)).arrayBuffer());
  writeFileSync(`${OUT}/${name}.png`, buf);
  console.log("captured", name);
}
const press = (b: string) =>
  fetch(`${URL_}/button/${b}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "press-and-release" }) }).catch(() => {});

async function connect() {
  const dmk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(URL_)).build();
  const sessionId: string = await new Promise((resolve, reject) => {
    const sub = dmk.startDiscovering({}).subscribe({
      next: async (device: any) => { const id = await dmk.connect({ device }); sub.unsubscribe(); resolve(id); },
      error: reject,
    });
    setTimeout(() => reject(new Error("no speculos on :5111")), 10_000);
  });
  const signer = new SignerEthBuilder({ dmk, sessionId }).build();
  return { dmk, sessionId, signer };
}

/** kick off a sign, capture each review page while paging right, then approve */
async function captureSign(signer: any, message: any, prefix: string) {
  let done = false;
  // we only want the review screens — never reject the promise (avoids crashing on a rejected sign)
  const p = new Promise<void>((resolve) => {
    try {
      signer.signMessage(DERIVATION, message).observable.subscribe({
        next: (s: any) => { if (s.status === "completed" || s.status === "error") { done = true; resolve(); } },
        error: () => { done = true; resolve(); },
      });
    } catch { done = true; resolve(); }
  });
  await sleep(800); // let the review render
  for (let i = 0; i < 6 && !done; i++) { await shot(`${prefix}-${i}`); await press("right"); await sleep(450); }
  // approve to end the flow cleanly (back up one from Reject, then confirm)
  for (let i = 0; i < 30 && !done; i++) { await press("left"); await sleep(120); await press("both"); await sleep(150); }
  await p;
}

const { dmk, sessionId, signer } = await connect();
try {
  await captureSign(signer, "notyet:view:0", "view"); // the audit view-key signing screen
  await sleep(600);
  await captureSign(signer, "notyet:approve withdraw over per-tx cap", "overcap"); // over-cap approval screen
} finally {
  await dmk.disconnect({ sessionId }).catch(() => {});
}
console.log("done");
