/**
 * Fixture generator for forge tests.
 *
 * Usage:
 *   tsx src/gen-fixture.ts <preimage> <salt> <action_hash_hi> <action_hash_lo>
 *
 * Each argument is a 0x-prefixed bytes32 hex.
 *
 * Output: a single 0x-prefixed hex string on stdout — the raw UltraHonk proof
 *         bytes for forge `vm.ffi` to parse. No trailing newline.
 *
 * Caches proofs under evm/test/fixtures/cache/<key>.hex where
 *   key = keccak256(circuitVkBytes || preimage || salt || hi || lo)
 * so repeated `forge test` runs skip the slow Noir/bb.js pipeline.
 */

// IMPORTANT: silence all console.* output to stdout *before* importing bb.js
// or noir_js, because they log "Generated proof for circuit..." and similar
// messages that would otherwise concatenate onto the proof hex when forge
// reads our stdout via vm.ffi. Redirect those to stderr so humans can still
// see them when running the script by hand.
const _origWrite = process.stdout.write.bind(process.stdout);
for (const m of ["log", "info", "debug", "warn"] as const) {
  const orig = console[m];
  console[m] = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";

function die(msg: string): never {
  process.stderr.write(`[gen-fixture] ${msg}\n`);
  process.exit(1);
}

const [, , preimage, salt, hi, lo] = process.argv;
if (!preimage || !salt || !hi || !lo) {
  die("usage: tsx src/gen-fixture.ts <preimage> <salt> <hi> <lo>");
}
for (const [name, v] of [["preimage", preimage], ["salt", salt], ["hi", hi], ["lo", lo]] as const) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) die(`invalid ${name}: expected 0x + 64 hex chars, got ${v}`);
}

import { fileURLToPath } from "node:url";

// Resolve paths relative to THIS file's location rather than CWD, so the
// script works whether invoked from repo root (yarn) or evm/ (forge ffi).
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..");
const CIRCUIT_PATH = resolve(REPO_ROOT, "circuits/intent/target/intent.json");
const CACHE_DIR = resolve(REPO_ROOT, "evm/test/fixtures/cache");

// Cache key: keccak-style digest over the circuit bytecode + all inputs.
// We want regenerated fixtures whenever the circuit changes (bytecode shifts).
function computeCacheKey(circuitBytecodeB64: string): string {
  const h = createHash("sha256");
  h.update(circuitBytecodeB64);
  h.update(preimage);
  h.update(salt);
  h.update(hi);
  h.update(lo);
  return h.digest("hex");
}

async function main() {
  const circuit = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8"));
  const cacheKey = computeCacheKey(circuit.bytecode);
  const cachePath = resolve(CACHE_DIR, `${cacheKey}.hex`);

  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8").trim();
    _origWrite(cached);
    return;
  }

  // Cache miss — generate the proof.
  const noir = new Noir(circuit);
  const { witness } = await noir.execute({
    preimage,
    salt,
    action_hash_hi: hi,
    action_hash_lo: lo,
  });

  const bb = await Barretenberg.new({ threads: 1 });
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, bb);
    const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
    const hex = "0x" + Buffer.from(proof.proof).toString("hex");

    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, hex);
    _origWrite(hex);
  } finally {
    await bb.destroy();
  }
}

main().catch((err) => {
  process.stderr.write(`[gen-fixture] error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
