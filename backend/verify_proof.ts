// Verifies the live proof response is self-consistent using the same
// compute_root logic as the Noir circuit.
import { BarretenbergSync, Fr } from '@aztec/bb.js';

const bb = await BarretenbergSync.initSingleton();
function hash(inputs: bigint[]): bigint {
  return BigInt(bb.pedersenHash(inputs.map(x => new Fr(x)), 0).toString());
}

const leaf      = 16285383130816713414875505228979288118031826271544080086166006549336213954567n;
const index     = 2;
const hashPath  = [
  0n,
  9372372252467977430075741964865855898258481737189008100658624677548927686268n,
  15315010434373228768515045847926951401477884091230007539886053341418284848464n,
  5337862867875115524214345623787399434458805399542698299566394924328104755643n,
  3120476356109763337029616398980250392595092048585115036648644377950387540381n,
  1713640813182293640789595917939697287037938209669543521747647487822835744672n,
];
const expectedRoot = 3107209679496494938527866128503767842509223879710548929766456514821660292224n;

let current = leaf;
for (let i = 0; i < 6; i++) {
  const bit = (BigInt(index) >> BigInt(i)) & 1n;
  const [left, right] = bit === 1n ? [hashPath[i], current] : [current, hashPath[i]];
  current = hash([left, right]);
}
console.log('Recomputed root:', current.toString());
console.log('Expected  root:', expectedRoot.toString());
console.log(current === expectedRoot ? '✓ PROOF VALID' : '✗ MISMATCH');
