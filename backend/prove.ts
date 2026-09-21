// End-to-end proof generation, in-process — no Prover.toml, no `nargo`/`bb` CLI calls.
//
// Multi-election flow: register against a specific batch (create one first if you
// don't have one), close it to get a root, have the owner call createElection() on
// -chain with that root, then this script waits for the backend to observe the
// resulting ElectionRegistered event and link the batch to its on-chain electionId
// before generating and submitting the proof.
//
// Run with: npx tsx prove.ts
import { readFileSync } from 'fs';
import { Barretenberg, BarretenbergSync, UltraHonkBackend, fieldToString } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';
import type { CompiledCircuit, InputMap } from '@noir-lang/types';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

// ── Config — edit these per test run ────────────────────────────────────────

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8545';
const CIRCUIT_PATH = new URL('../circuits/target/circuts.json', import.meta.url);

const SECRET = process.env.SECRET ? BigInt(process.env.SECRET) : 3n; // the voter's private secret — never sent to the backend
const VOTE = process.env.VOTE ? Number(process.env.VOTE) : 2;        // candidate index, 0-3

// Which registration batch to use. Leave unset to start a fresh one (POST
// /elections) — print it out so you can pass BATCH_ID=<n> on later runs to
// register more voters against the same batch before closing it.
const BATCH_ID = process.env.BATCH_ID ? Number(process.env.BATCH_ID) : undefined;

// Fill these in with your actual deployment — the Voting contract's address, and
// the private key of the account that will submit (and pay gas for) the vote.
// This does NOT need to be the same key that deployed the contracts.
const VOTING_ADDRESS = (process.env.VOTING_ADDRESS ?? '0x0000000000000000000000000000000000000000') as Hex;
const VOTER_PRIVATE_KEY = (process.env.VOTER_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex;

const votingAbi = [
  {
    type: 'function',
    name: 'vote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'proof', type: 'bytes' },
      { name: 'publicInputs', type: 'bytes32[]' },
    ],
    outputs: [],
  },
] as const;

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

interface BatchInfo {
  batchId: number;
  onChainElectionId: string | null;
  candidates: string[] | null;
  registrationClosed: boolean;
  registeredCount: number;
  root?: string;
}

async function createBatch(): Promise<number> {
  const res = await fetch(`${BACKEND_URL}/elections`, { method: 'POST' });
  if (!res.ok) throw new Error(`create batch failed: ${res.status} ${await res.text()}`);
  const { batchId } = await res.json() as { batchId: number };
  return batchId;
}

async function getBatchInfo(batchId: number): Promise<BatchInfo> {
  const res = await fetch(`${BACKEND_URL}/elections/${batchId}`);
  if (!res.ok) throw new Error(`get batch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<BatchInfo>;
}

async function registerVoter(batchId: number, commitment: bigint): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/elections/${batchId}/register`, {
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

async function closeRegistration(batchId: number): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/elections/${batchId}/close-registration`, { method: 'POST' });
  if (!res.ok) throw new Error(`close-registration failed: ${res.status} ${await res.text()}`);
}

async function getMerkleProof(batchId: number, commitment: bigint): Promise<{ index: number; hashPath: string[]; root: string }> {
  const res = await fetch(`${BACKEND_URL}/elections/${batchId}/merkle-proof/${commitment.toString()}`);
  if (!res.ok) throw new Error(`merkle-proof failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ index: number; hashPath: string[]; root: string }>;
}

// Polls /elections/:batchId until the backend's chain watcher has linked it to an
// on-chain electionId (i.e. until it sees createElection() called with this
// batch's root). That call happens outside this script — run it (cast/forge
// script) after this prints the root, while this keeps polling.
async function waitForLink(batchId: number, timeoutMs = 120_000): Promise<bigint> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getBatchInfo(batchId);
    if (info.onChainElectionId !== null) return BigInt(info.onChainElectionId);
    console.log('  waiting for createElection() on-chain to be linked...');
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Timed out waiting for batch #${batchId} to be linked to an on-chain election`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  bb = await BarretenbergSync.initSingleton();

  const batchId = BATCH_ID ?? await createBatch();
  console.log('batchId:', batchId, BATCH_ID === undefined ? '(newly created)' : '');

  const commitment = pedersenHash([SECRET]);
  console.log('commitment:', commitment.toString());

  await registerVoter(batchId, commitment);
  await closeRegistration(batchId);

  const info = await getBatchInfo(batchId);
  console.log('root:', info.root);

  console.log('\nWaiting for this batch to be linked to an on-chain election...');
  console.log('(run createElection() on-chain with the root above, in a separate terminal, if you haven\'t yet)');
  const onChainElectionId = await waitForLink(batchId);
  console.log('linked to on-chain electionId:', onChainElectionId.toString());

  const { index, hashPath, root } = await getMerkleProof(batchId, commitment);

  const nullifier = pedersenHash([SECRET, onChainElectionId]);
  console.log('nullifier:', nullifier.toString());

  const circuit: CompiledCircuit = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf-8'));

  const inputs: InputMap = {
    secret: SECRET.toString(),
    index: index.toString(),
    hash_path: hashPath,
    vote: VOTE.toString(),
    election_id: onChainElectionId.toString(),
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
  await api.destroy();

  const proofHex = ('0x' + Buffer.from(proof).toString('hex')) as Hex;
  console.log('proof: ', proof.length, 'bytes');
  console.log('publicInputs (order: vote, election_id, root, nullifier):', publicInputs);

  console.log('\nSubmitting vote() on-chain...');
  const account = privateKeyToAccount(VOTER_PRIVATE_KEY);
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });

  const hash = await walletClient.writeContract({
    address: VOTING_ADDRESS,
    abi: votingAbi,
    functionName: 'vote',
    args: [onChainElectionId, proofHex, publicInputs as Hex[]],
  });
  console.log('tx sent:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('status:', receipt.status, ' gasUsed:', receipt.gasUsed.toString());
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
