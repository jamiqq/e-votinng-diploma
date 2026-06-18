// Verifies that bb.js Pedersen hash matches the Noir circuit test vector.
// Expected from Prover.toml:
//   secret = 3, index = 2
//   hash_path = [2256689276..., 1985195406..., ...]
//   root = 13477193859756245466565538420960270577998697290395943136479433768751572520273
//
// To reconstruct: we need to know all leaves. The circuit test_valid_proof has
// secret=3 at index=2, which means leaf[2] = pedersen_hash([3]).
// The hash_path[0] is the sibling of leaf[2], i.e. leaf[3].
// We can verify by recomputing the root along the path using only the path data.

import { BarretenbergSync, Fr } from '@aztec/bb.js';

const bb = await BarretenbergSync.initSingleton();

function frToBigInt(f: Fr): bigint {
  return BigInt(f.toString());
}

function pedersenHash(inputs: bigint[]): bigint {
  const frs = inputs.map(x => new Fr(x));
  const result = (bb as any).pedersenHash(frs, 0);
  return frToBigInt(result);
}

// From circuit test_valid_proof
const secret = 3n;
const index = 2;
const hash_path = [
  2256689276847399345359792277406644462014723416398290212952821205940959307205n,
  1985195406472859805732720085313401851943726940210351648104245812061928359031n,
  17637850887138168665484989447303297665818927781851584321725153796975171356544n,
  20058509129372086033793589469556586593012197981700026421557673063737159116266n,
  453372490960416314274918066540000171406262359142318949314164256006589949684n,
  20126640341552099798587948537002247874700958206787074606352126333231241235843n,
];
const expected_root = 13477193859756245466565538420960270577998697290395943136479433768751572520273n;

// Step 1: compute leaf
const leaf = pedersenHash([secret]);
console.log('leaf = pedersen_hash([3]):', leaf.toString());

// Step 2: recompute root via the circuit's compute_root logic
let current = leaf;
for (let i = 0; i < 6; i++) {
  const bit_i = (BigInt(index) >> BigInt(i)) & 1n;
  let left: bigint, right: bigint;
  if (bit_i === 1n) {
    // current is RIGHT child, sibling is LEFT
    left = hash_path[i];
    right = current;
  } else {
    left = current;
    right = hash_path[i];
  }
  current = pedersenHash([left, right]);
  console.log(`level ${i}: bit=${bit_i} → hash([${bit_i ? 'sibling' : 'current'}, ${bit_i ? 'current' : 'sibling'}]) = ${current}`);
}

console.log('\nComputed root:', current.toString());
console.log('Expected root:', expected_root.toString());
console.log('MATCH:', current === expected_root ? '✓ YES' : '✗ NO — hash mismatch, check convention');
