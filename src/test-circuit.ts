/**
 * Isolated proof-generation sanity check.
 *
 * Validates that:
 *   - poseidon2 off-chain matches Noir's Poseidon2::hash
 *   - Witness generation + UltraHonk proving work end-to-end
 *   - verifyProof accepts the generated proof with verifierTarget: 'evm'
 *
 * Does not touch the bridge, Anvil, or Aztec sandbox.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";

async function main() {
  const circuitPath = resolve(process.cwd(), "circuits/intent/target/intent.json");
  const circuit = JSON.parse(readFileSync(circuitPath, "utf8"));

  const preimage = Fr.random();
  const salt = await poseidon2Hash([preimage]);
  console.log(`preimage: ${preimage.toString()}`);
  console.log(`salt:     ${salt.toString()}`);

  const actionHashHi = "0x" + "00".repeat(16) + "deadbeefcafef00dbaadbaadbaadbaad";
  const actionHashLo = "0x" + "00".repeat(16) + "0000000000000000000000000000ffff";

  console.log("[1] Generating witness...");
  const noir = new Noir(circuit);
  const { witness } = await noir.execute({
    preimage: preimage.toString(),
    salt: salt.toString(),
    action_hash_hi: actionHashHi,
    action_hash_lo: actionHashLo,
  });
  console.log("    ok");

  console.log("[2] Initializing Barretenberg...");
  const bb = await Barretenberg.new({ threads: 1 });
  const backend = new UltraHonkBackend(circuit.bytecode, bb);
  console.log("    ok");

  console.log("[3] Generating proof (verifierTarget=evm)...");
  const t0 = Date.now();
  const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
  console.log(`    proof bytes: ${proof.proof.length}, public inputs: ${proof.publicInputs.length}, took ${Date.now() - t0}ms`);

  console.log("[4] Verifying proof off-chain via bb.js...");
  const ok = await backend.verifyProof(proof, { verifierTarget: "evm" });
  if (!ok) throw new Error("bb.js verifyProof returned false");
  console.log("    ok");

  console.log("\n[5] Sanity: public inputs from proof:");
  for (const [i, pi] of proof.publicInputs.entries()) console.log(`    [${i}] ${pi}`);

  await bb.destroy();
  console.log("\nCircuit pipeline works.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
