import { BarretenbergSync, fieldToString } from '@aztec/bb.js';

export const TREE_DEPTH = 6;
export const TREE_SIZE = 1 << TREE_DEPTH; // 64

// Module-level singleton — initialized once before the server starts.
let _bb: BarretenbergSync | null = null;

export async function initBarretenberg(): Promise<void> {
  _bb = await BarretenbergSync.initSingleton();
}

function bb(): BarretenbergSync {
  if (!_bb) throw new Error('Barretenberg not initialized — call initBarretenberg() first');
  return _bb;
}

// bb.js 5.x dropped the Fr-wrapper pedersenHash(frs, index) API in favor of raw
// 32-byte big-endian field encodings (see PedersenHash's { inputs: Uint8Array[] } shape).
function bigintToField(x: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

// Computes std::hash::pedersen_hash (hash_index=0) over an array of field elements.
// Matches exactly what the Noir circuit computes.
function pedersenHash(inputs: bigint[]): bigint {
  const { hash } = bb().pedersenHash({ inputs: inputs.map(bigintToField), hashIndex: 0 });
  return BigInt(fieldToString(hash));
}

export class MerkleTree {
  // Voter commitments in registration order (unpadded during registration).
  private leaves: bigint[] = [];

  // Full tree levels after closing:
  //   levels[0]  = 64 padded leaves
  //   levels[k]  = 64 >> k nodes at depth k
  //   levels[6]  = [root]
  private levels: bigint[][] = [];

  private closed = false;

  // Returns true once close() has been called.
  get isClosed(): boolean {
    return this.closed;
  }

  // Returns the number of registered voters.
  get registeredCount(): number {
    return this.leaves.length;
  }

  // Adds a voter commitment. Returns the assigned 0-based index.
  // Throws if registration is closed or the tree is at capacity.
  addLeaf(commitment: bigint): number {
    if (this.closed) throw new Error('Registration is already closed');
    if (this.leaves.length >= TREE_SIZE) throw new Error('Tree is at full capacity (64 voters)');
    this.leaves.push(commitment);
    return this.leaves.length - 1;
  }

  // Pads leaves to TREE_SIZE with 0n, then builds the full Merkle tree.
  // Idempotent: calling it a second time is a no-op (returns immediately).
  close(): void {
    if (this.closed) return;

    const padded = [...this.leaves];
    while (padded.length < TREE_SIZE) padded.push(0n);

    this.levels = [padded];
    for (let depth = 0; depth < TREE_DEPTH; depth++) {
      const current = this.levels[depth];
      const next: bigint[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(pedersenHash([current[i], current[i + 1]]));
      }
      this.levels.push(next);
    }

    this.closed = true;
  }

  // Returns the Merkle root. Only available after close().
  getRoot(): bigint {
    if (!this.closed) throw new Error('Registration is not closed yet — call close() first');
    return this.levels[TREE_DEPTH][0];
  }

  // Returns the Merkle proof (index + sibling path) for a given commitment.
  // The hash_path array has exactly TREE_DEPTH (6) elements, matching the circuit's
  // `hash_path: [Field; 6]` parameter. hash_path[k] is the sibling at tree level k,
  // indexed via (leafIndex >> k) ^ 1 — consistent with the circuit's LE-bit traversal.
  getMerkleProof(commitment: bigint): { index: number; hashPath: bigint[] } {
    if (!this.closed) throw new Error('Registration is not closed yet — call close() first');

    const index = this.leaves.indexOf(commitment);
    if (index === -1) throw new Error('Commitment not found among registered voters');

    const hashPath: bigint[] = [];
    for (let depth = 0; depth < TREE_DEPTH; depth++) {
      const siblingIndex = (index >> depth) ^ 1;
      hashPath.push(this.levels[depth][siblingIndex]);
    }

    return { index, hashPath };
  }
}
