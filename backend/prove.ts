// End-to-end proof generation, in-process — no Prover.toml, no `nargo`/`bb` CLI calls.
//
// Replaces the manual flow of: edit Prover.toml -> nargo execute -> bb prove -> xxd the
// output files by hand. Uses @noir-lang/noir_js to generate the witness and @aztec/bb.js's
// UltraHonkBackend to generate the proof, exactly like a real browser voter would (per the
// project README), just running in Node instead of a browser.
//
// Run with: npx tsx prove.ts
import { readFileSync } from 'fs';
import { Barretenberg, BarretenbergSync, UltraHonkBackend, fieldToString } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import type { CompiledCircuit, InputMap } from '@noir-lang/types';

// ── Config — edit these per test run ────────────────────────────────────────

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const CIRCUIT_PATH = new URL('../circuits/target/circuts.json', import.meta.url);

const SECRET = 3n;          // the voter's private secret — never sent to the backend
const VOTE = 2;             // candidate index, 0-3

// Must equal the on-chain election's array index (the id you pass into Voting.vote()),
// NOT election.ts's ELECTION_ID constant — those are two separate, currently-unrelated
// numbers in this codebase. Get this wrong and Voting.vote() reverts with
// "Mismatch in elections chosen".
const ON_CHAIN_ELECTION_ID = 0n;

// ── Pedersen hashing (byte-identical to Noir's std::hash::pedersen_hash) ────

let bb: BarretenbergSync;

// bb.js 5.x dropped the old Fr-wrapper pedersenHash(frs, index) API in favor of raw
// 32-byte big-endian field encodings — see PedersenHash's { inputs: Uint8Array[] } shape.
function bigintToField(x: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

function pedersenHash(inputs: bigint[]): bigint {
  const { hash } = bb.pedersenHash({ inputs: inputs.map(bigintToField), hashIndex: 0 });
  return BigInt(fieldToString(hash));
}

// ── Backend HTTP helpers ─────────────────────────────────────────────────────

async function registerVoter(commitment: bigint): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitment: commitment.toString() }),
  });
  if (res.ok) return;

  const body = await res.json().catch(() => ({})) as { error?: string };
  // Registration already closed (or this commitment already registered in an earlier
  // run of this script) isn't fatal — the commitment may already be in the tree.
  // Whether it actually is gets settled by the merkle-proof fetch below.
  console.warn(`register: ${res.status} ${body.error ?? res.statusText} (continuing)`);
}

async function closeRegistration(): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/close-registration`, { method: 'POST' });
  if (!res.ok) throw new Error(`close-registration failed: ${res.status} ${await res.text()}`);
}

async function getMerkleProof(commitment: bigint): Promise<{ index: number; hashPath: string[]; root: string }> {
  const res = await fetch(`${BACKEND_URL}/merkle-proof/${commitment.toString()}`);
  if (!res.ok) throw new Error(`merkle-proof failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ index: number; hashPath: string[]; root: string }>;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  bb = await BarretenbergSync.initSingleton();

  const commitment = pedersenHash([SECRET]);
  console.log('commitment:', commitment.toString());

  await registerVoter(commitment);
  await closeRegistration();
  const { index, hashPath, root } = await getMerkleProof(commitment);
  console.log('index:', index, ' root:', root);

  const nullifier = pedersenHash([SECRET, ON_CHAIN_ELECTION_ID]);
  console.log('nullifier:', nullifier.toString());

  const circuit: CompiledCircuit = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf-8'));

  const inputs: InputMap = {
    secret: SECRET.toString(),
    index: index.toString(),
    hash_path: hashPath,
    vote: VOTE.toString(),
    election_id: ON_CHAIN_ELECTION_ID.toString(),
    root,
    nullifier: nullifier.toString(),
  };

  console.log('\nExecuting circuit to generate witness...');
  const noir = new Noir(circuit);
  const { witness } = await noir.execute(inputs);

  console.log('Generating proof (this can take a while)...');
  const api = await Barretenberg.new();
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  // 'evm' = keccak-based hashing + ZK, matching the bb CLI's `-t evm` and the
  // generated HonkVerifier.sol. 'evm-no-zk' (the old `{ keccak: true }` default)
  // is a different, incompatible proving variant — using it here silently produces
  // a proof the on-chain verifier will reject.
  const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });

  console.log('\n=== Ready for cast send ===');
  console.log('electionId:', ON_CHAIN_ELECTION_ID.toString());
  console.log('proof:     ', '0x' + Buffer.from(proof).toString('hex'));
  console.log('publicInputs (order: vote, election_id, root, nullifier):');
  console.log('  [' + publicInputs.join(',') + ']');

  await api.destroy();
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
