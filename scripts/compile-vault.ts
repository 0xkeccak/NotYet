/**
 * Compile contracts/PeriodVault.sol → contracts/PeriodVault.json (abi + bytecode).
 * Run once after editing the contract: `npx tsx scripts/compile-vault.ts`.
 * Kept as a committed artifact so the deploy path needs no compiler at runtime.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(root + "contracts/PeriodVault.sol", "utf8");

const input = {
  language: "Solidity",
  sources: { "PeriodVault.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: any) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of out.errors ?? []) console.warn(w.formattedMessage);

const c = out.contracts["PeriodVault.sol"].PeriodVault;
const artifact = { abi: c.abi, bytecode: c.evm.bytecode.object };
writeFileSync(root + "contracts/PeriodVault.json", JSON.stringify(artifact, null, 2));
console.log(`✓ compiled PeriodVault — bytecode ${artifact.bytecode.length / 2} bytes, ${c.abi.length} abi entries`);
