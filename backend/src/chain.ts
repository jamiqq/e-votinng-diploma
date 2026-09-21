// On-chain read access for the Voting contract: fetching election metadata and
// watching for ElectionRegistered events, so the backend can link an off-chain
// registration batch (a Merkle tree it built) to the on-chain election it becomes
// once the owner calls createElection() with that batch's root.
import { createPublicClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8545';
const VOTING_ADDRESS = process.env.VOTING_ADDRESS as Hex | undefined;

export const votingAbi = [
  {
    type: 'event',
    name: 'ElectionRegistered',
    inputs: [
      { name: 'electionId', type: 'uint256', indexed: true },
      { name: 'root', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'function',
    name: 'elections',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    // Solidity's auto-generated getter for a public array of structs skips any
    // dynamic-type member (here, Candidate[] candidates) — only the scalar fields
    // come back. Candidate names are fetched separately via viewCandidateNames.
    outputs: [
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'startTime', type: 'uint256' },
      { name: 'endTime', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'viewCandidateNames',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string[]' }],
  },
] as const;

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });

export interface OnChainElectionMeta {
  electionId: bigint;
  root: bigint;
  startTime: bigint;
  endTime: bigint;
  candidates: string[];
}

// Reads full metadata for an already-known on-chain election id.
export async function fetchElectionMeta(electionId: bigint): Promise<OnChainElectionMeta> {
  if (!VOTING_ADDRESS) throw new Error('VOTING_ADDRESS is not set');

  const [merkleRoot, startTime, endTime] = await publicClient.readContract({
    address: VOTING_ADDRESS,
    abi: votingAbi,
    functionName: 'elections',
    args: [electionId],
  });

  const candidates = await publicClient.readContract({
    address: VOTING_ADDRESS,
    abi: votingAbi,
    functionName: 'viewCandidateNames',
    args: [electionId],
  });

  return { electionId, root: BigInt(merkleRoot), startTime, endTime, candidates: [...candidates] };
}

// Watches ElectionRegistered events and invokes onLinked(electionId, root) for
// every one seen — both new ones as they're mined, and any that were already on
// chain before this process started (so a backend restart doesn't lose the
// linkage for elections created earlier).
export async function watchElectionRegistrations(
  onLinked: (electionId: bigint, root: bigint) => void,
): Promise<void> {
  if (!VOTING_ADDRESS) {
    console.warn('VOTING_ADDRESS not set — skipping on-chain election watcher. ' +
      'Elections will stay unlinked until it is configured and the backend is restarted.');
    return;
  }

  // Catch up on history first — watchContractEvent only sees logs from the moment
  // it starts polling onward.
  const pastLogs = await publicClient.getContractEvents({
    address: VOTING_ADDRESS,
    abi: votingAbi,
    eventName: 'ElectionRegistered',
    fromBlock: 0n,
  });
  for (const log of pastLogs) {
    if (log.args.electionId !== undefined && log.args.root !== undefined) {
      onLinked(log.args.electionId, BigInt(log.args.root));
    }
  }

  publicClient.watchContractEvent({
    address: VOTING_ADDRESS,
    abi: votingAbi,
    eventName: 'ElectionRegistered',
    onLogs: logs => {
      for (const log of logs) {
        if (log.args.electionId !== undefined && log.args.root !== undefined) {
          onLinked(log.args.electionId, BigInt(log.args.root));
        }
      }
    },
  });

  console.log(`Watching ${VOTING_ADDRESS} for ElectionRegistered events (${pastLogs.length} found already).`);
}
