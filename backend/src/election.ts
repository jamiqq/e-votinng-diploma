// The election store: one MerkleTree per registration batch, linked to its
// on-chain Voting election once createElection() is called with that batch's
// root and the ElectionRegistered event is observed (see chain.ts).
//
// A "batch" starts as purely off-chain state (registrations against a fresh
// tree) — it has no on-chain identity yet. Once the owner calls createElection()
// on-chain with this batch's root, the resulting ElectionRegistered(electionId,
// root) event lets us match it back to this batch by root and record the
// on-chain electionId, candidates, and timing. `batchId` (assigned here) is
// stable and is what callers use in the API; `onChainElectionId` is only known
// after linking, and is what actually goes into the circuit's `election_id`
// input and the nullifier.
import { MerkleTree } from './merkle.js';
import { fetchElectionMeta } from './chain.js';

export interface ElectionBatch {
  batchId: number;
  tree: MerkleTree;
  onChainElectionId?: bigint;
  candidates?: string[];
  startTime?: bigint;
  endTime?: bigint;
}

const batches: ElectionBatch[] = [];

export function createBatch(): ElectionBatch {
  const batch: ElectionBatch = { batchId: batches.length, tree: new MerkleTree() };
  batches.push(batch);
  return batch;
}

export function getBatch(batchId: number): ElectionBatch | undefined {
  return batches[batchId];
}

export function listBatches(): readonly ElectionBatch[] {
  return batches;
}

// Finds the (not yet linked) batch whose closed tree produced this root.
function findUnlinkedBatchByRoot(root: bigint): ElectionBatch | undefined {
  return batches.find(
    b => b.onChainElectionId === undefined && b.tree.isClosed && b.tree.getRoot() === root,
  );
}

// Called by the chain watcher for every ElectionRegistered(electionId, root) it
// sees. If the root matches a batch this backend built, link it and pull the
// rest of the election's metadata (candidates, timing) from chain.
export async function linkBatchToChain(electionId: bigint, root: bigint): Promise<void> {
  const batch = findUnlinkedBatchByRoot(root);
  if (!batch) {
    // Root not recognized as one of ours — e.g. an election created with a
    // hand-picked root outside this backend. Nothing to link.
    return;
  }

  batch.onChainElectionId = electionId;
  const meta = await fetchElectionMeta(electionId);
  batch.candidates = meta.candidates;
  batch.startTime = meta.startTime;
  batch.endTime = meta.endTime;

  console.log(`Linked batch #${batch.batchId} to on-chain election #${electionId} (root ${root}).`);
}
