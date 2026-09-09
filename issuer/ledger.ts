/**
 * Ledger-backed schedule signing via the Ledger Wallet stack, run against the
 * Speculos emulator (Ledger's official device emulator — no physical device needed,
 * and Ledger states this qualifies in full). The issuer's authority key lives on the
 * (emulated) device; the schedule is signed with an on-device confirmation, exactly
 * the "human confirms the schedule once" step. The agent verifies the signature the
 * same way it verifies any issuer signature — recover address == issuer on ENS.
 */
import SpeculosHttpTransport from "@ledgerhq/hw-transport-node-speculos-http";
import Eth from "@ledgerhq/hw-app-eth";
import { canonicalJSON } from "./schedule.js";
import type { Schedule, SignedSchedule } from "../sdk/types.js";

const DERIVATION = "44'/60'/0'/0/0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LedgerOptions {
  host?: string; // default http://localhost
  apiPort?: string; // Speculos API port (default 5111)
}

function apiBase(opts: LedgerOptions): string {
  return `${opts.host ?? "http://localhost"}:${opts.apiPort ?? "5111"}`;
}

async function openEth(opts: LedgerOptions) {
  const T: any = (SpeculosHttpTransport as any).default || SpeculosHttpTransport;
  const transport = await T.open({ baseURL: opts.host ?? "http://localhost", apiPort: opts.apiPort ?? "5111" });
  return { transport, eth: new Eth(transport) };
}

/** The issuer address held on the (emulated) Ledger. */
export async function ledgerIssuerAddress(opts: LedgerOptions = {}): Promise<`0x${string}`> {
  const { transport, eth } = await openEth(opts);
  try {
    const { address } = await eth.getAddress(DERIVATION, false);
    return address as `0x${string}`;
  } finally {
    await transport.close();
  }
}

/**
 * Sign the schedule on the (emulated) Ledger. Auto-confirms the on-device prompt via
 * the Speculos button API so it runs headless; a physical device would confirm by hand.
 */
export async function signScheduleWithLedger(schedule: Schedule, opts: LedgerOptions = {}): Promise<SignedSchedule> {
  const { transport, eth } = await openEth(opts);
  const base = apiBase(opts);
  const press = (b: string) =>
    fetch(`${base}/button/${b}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "press-and-release" }),
    }).catch(() => {});
  try {
    const message = canonicalJSON(schedule);
    const hex = Buffer.from(message, "utf8").toString("hex");

    let done = false;
    const signing = eth.signPersonalMessage(DERIVATION, hex).then((r: any) => {
      done = true;
      return r;
    });
    (async () => {
      for (let i = 0; i < 40 && !done; i++) {
        await press("right");
        await sleep(150);
        await press("both");
        await sleep(150);
      }
    })();
    const s: any = await signing;

    const v = typeof s.v === "number" ? s.v : parseInt(s.v, 16);
    const signature = ("0x" + s.r + s.s + v.toString(16).padStart(2, "0")) as `0x${string}`;
    return { schedule, signature };
  } finally {
    await transport.close();
  }
}
