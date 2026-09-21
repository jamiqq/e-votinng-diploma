// TEST-ONLY fixture generator: deterministically derives a secret (and its
// commitment) for each test voter identity below, so you can track which
// secret belongs to which test voter across separate `prove.ts` runs.
//
// Do NOT use this pattern for real voters. A secret derived from an identity
// + a salt you know is a secret you can also compute — which means you (or
// anyone who learns the salt) can compute any voter's commitment and, from
// their published nullifier, tell how they voted. That defeats the entire
// point of the secret: it's supposed to exist only in the voter's own head.
// Real voters must generate their own secret client-side (e.g. random bytes
// in the browser) and never send it anywhere, including here.
//
// Run with: npx tsx test-voters.ts
import { createHash } from 'crypto';
import { BarretenbergSync, fieldToString } from '@aztec/bb.js';

// The BN254 (alt_bn128) scalar field modulus — the same field Noir's `Field`
// type and Barretenberg's Pedersen hash operate over. Secrets must be reduced
// into this range to be valid circuit inputs.
const BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Change this between test runs/cohorts if you want a different set of
// derived secrets for the same identities (e.g. to simulate a "new election
// cycle" without reusing the exact same commitments).
const SALT = process.env.TEST_VOTER_SALT ?? 'local-test-salt-change-me';

// Add/remove test voter identities here.
const TEST_VOTERS = [
  'alice@example.com',
  'bob@example.com',
  'carol@example.com',
  'dave@example.com',
  'eve@example.com',
];

function bigintToField(x: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

async function main() {
  const bb = await BarretenbergSync.initSingleton();
  function pedersenHash(inputs: bigint[]): bigint {
    const { hash } = bb.pedersenHash({ inputs: inputs.map(bigintToField), hashIndex: 0 });
    return BigInt(fieldToString(hash));
  }

  console.log('label,secret,commitment');
  for (const label of TEST_VOTERS) {
    const digest = createHash('sha256').update(`${label}:${SALT}`).digest('hex');
    const secret = BigInt('0x' + digest) % BN254_FR_MODULUS;
    const commitment = pedersenHash([secret]);
    console.log(`${label},${secret.toString()},${commitment.toString()}`);
  }

  console.log('\nFor each voter: register their commitment against your batch, then run');
  console.log('  SECRET=<secret> BATCH_ID=<n> VOTE=<0-3> npx tsx prove.ts');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
