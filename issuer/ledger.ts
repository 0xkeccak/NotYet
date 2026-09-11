/**
 * Ledger-backed schedule signing via the **Ledger Device Management Kit (DMK)** — Ledger's
 * current device stack (the Ledger Agent Stack), which supersedes the legacy hw-app-*
 * libraries. Runs against the Speculos emulator over DMK's official HTTP transport
 * (`@ledgerhq/device-transport-kit-speculos`) — no physical device needed.
 *
 * The issuer's authority key lives on the device. Signing the schedule is the one
 * human-in-the-loop, on-device approval in the whole system: the owner approves the
 * entire budget once, then walks away. The agent later verifies that signature against
 * the issuer address published on ENS and refuses if it doesn't match.
 */
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
import { speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { hexToBytes } from "viem";
import { hkdfSync } from "node:crypto";
import nacl from "tweetnacl";
import { canonicalJSON } from "./schedule.js";
import { withdrawDigest, type WithdrawDigestInput, type WithdrawSig } from "../sdk/vault.js";
import type { Schedule, SignedSchedule } from "../sdk/types.js";

const DERIVATION = "44'/60'/0'/0/0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LedgerOptions {
  host?: string; // default http://localhost
  apiPort?: string; // Speculos API port (default 5111)
}

function speculosUrl(o: LedgerOptions): string {
  return `${o.host ?? "http://localhost"}:${o.apiPort ?? "5111"}`;
}

async function connect(opts: LedgerOptions) {
  const url = speculosUrl(opts);
  const dmk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(url)).build();
  const sessionId: string = await new Promise((resolve, reject) => {
    const sub = dmk.startDiscovering({}).subscribe({
      next: async (device) => {
        try {
          const id = await dmk.connect({ device });
          sub.unsubscribe();
          resolve(id);
        } catch (e) {
          reject(e);
        }
      },
      error: reject,
    });
    setTimeout(() => reject(new Error(`Ledger (Speculos) not found on ${url} — is it running? (bash scripts/speculos-up.sh)`)), 10_000);
  });
  const signer = new SignerEthBuilder({ dmk, sessionId }).build();
  return { dmk, sessionId, signer, url };
}

/** Consume a DMK device-action observable, auto-approving the on-device prompt via the
 *  Speculos button API so it runs headless (a physical device confirms by hand). */
async function runAction<T>(action: { observable: any }, url: string): Promise<T> {
  let done = false;
  const press = (b: string) =>
    fetch(`${url}/button/${b}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "press-and-release" }),
    }).catch(() => {});
  (async () => {
    for (let i = 0; i < 40 && !done; i++) {
      await press("right");
      await sleep(150);
      await press("both");
      await sleep(150);
    }
  })();
  try {
    return await new Promise<T>((resolve, reject) => {
      action.observable.subscribe({
        next: (s: any) => {
          if (s.status === "completed") resolve(s.output as T);
          else if (s.status === "error") reject(new Error(JSON.stringify(s.error)));
        },
        error: reject,
      });
    });
  } finally {
    done = true;
  }
}

/** The issuer address held on the (emulated) Ledger. */
export async function ledgerIssuerAddress(opts: LedgerOptions = {}): Promise<`0x${string}`> {
  const { dmk, sessionId, signer, url } = await connect(opts);
  try {
    const out = await runAction<{ address: string }>(signer.getAddress(DERIVATION), url);
    return out.address as `0x${string}`;
  } finally {
    await dmk.disconnect({ sessionId }).catch(() => {});
  }
}

/** Sign the schedule on the (emulated) Ledger via DMK; returns { schedule, signature }. */
export async function signScheduleWithLedger(schedule: Schedule, opts: LedgerOptions = {}): Promise<SignedSchedule> {
  const { dmk, sessionId, signer, url } = await connect(opts);
  try {
    const message = canonicalJSON(schedule);
    const s = await runAction<{ r: string; s: string; v: number | string }>(signer.signMessage(DERIVATION, message), url);
    const v = typeof s.v === "number" ? s.v : parseInt(s.v, 16);
    const signature = ("0x" +
      s.r.replace(/^0x/, "") +
      s.s.replace(/^0x/, "") +
      v.toString(16).padStart(2, "0")) as `0x${string}`;
    return { schedule, signature };
  } finally {
    await dmk.disconnect({ sessionId }).catch(() => {});
  }
}

const to32 = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
const normV = (v: number | string) => {
  const n = typeof v === "number" ? v : parseInt(v, 16);
  return n < 27 ? n + 27 : n; // the contract's ecrecover wants v ∈ {27,28}
};

/**
 * #2 — The over-cap approver co-sign, on the device.
 *
 * When an agent asks the vault for more than a period's `perTxMax`, `withdraw` also
 * requires a signature from the committed approver — the Ledger. This asks the device to
 * personal-sign the SAME digest the contract re-derives (tag "approve"), so a human tap
 * is the explicit boundary between autonomous small spends and a big irreversible one.
 * Signs the raw 32-byte digest as bytes so the EIP-191 prefix matches viem/the contract.
 */
export async function ledgerApproveWithdraw(
  d: Omit<WithdrawDigestInput, "tag">,
  opts: LedgerOptions = {},
): Promise<WithdrawSig> {
  const digest = withdrawDigest({ ...d, tag: "approve" });
  const { dmk, sessionId, signer, url } = await connect(opts);
  try {
    const s = await runAction<{ r: string; s: string; v: number | string }>(
      signer.signMessage(DERIVATION, hexToBytes(digest)),
      url,
    );
    return { v: normV(s.v), r: ("0x" + to32(s.r)) as `0x${string}`, s: ("0x" + to32(s.s)) as `0x${string}` };
  } finally {
    await dmk.disconnect({ sessionId }).catch(() => {});
  }
}

/**
 * #3 — Audit view keys born from the device.
 *
 * The agent encrypts each period's receipt to `publicKey` (it holds no secret — a secret
 * it literally cannot leak). Only a Ledger tap reconstructs `secretKey`: the device
 * personal-signs a fixed per-period string, and ECDSA is deterministic (RFC 6979), so the
 * same tap always yields the same key — but the key never touches disk. Disclosing period
 * i to an auditor is one on-device confirmation, scoped to that period alone.
 */
export async function ledgerViewKeyPair(
  i: number,
  opts: LedgerOptions = {},
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const { dmk, sessionId, signer, url } = await connect(opts);
  try {
    const s = await runAction<{ r: string; s: string; v: number | string }>(
      signer.signMessage(DERIVATION, `notyet:view:${i}`),
      url,
    );
    const sig65 = Buffer.from(to32(s.r) + to32(s.s) + normV(s.v).toString(16).padStart(2, "0"), "hex");
    const seed = Buffer.from(hkdfSync("sha256", sig65, Buffer.from("notyet:view"), Buffer.from(`v:${i}`), 32));
    const kp = nacl.box.keyPair.fromSecretKey(new Uint8Array(seed));
    return { publicKey: kp.publicKey, secretKey: kp.secretKey };
  } finally {
    await dmk.disconnect({ sessionId }).catch(() => {});
  }
}
