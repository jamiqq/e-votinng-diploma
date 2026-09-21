# Voting Backend

TypeScript/Express service that manages voter registration per election and keeps a read-only cache of on-chain election data (candidates, timing) in sync via chain events. Supports multiple concurrent elections.

## Overview

Each registration round is a **batch**: its own Merkle tree, created before the corresponding election exists on-chain (the root has to exist *before* `createElection()` can be called with it — that's the on-chain function's input, not its output).

The flow:
1. `POST /elections` starts a new batch. Returns `{ batchId }` — a stable identifier you use for everything below, independent of any on-chain id.
2. Voters call `POST /elections/:batchId/register` with their commitment (`pedersen_hash([secret])`). The **secret is never sent to the backend** — only the commitment.
3. An admin calls `POST /elections/:batchId/close-registration` once all voters for this round have registered. This pads the leaf array to 64 entries with `0` and builds the depth-6 Pedersen Merkle tree, returning the root.
4. The admin calls `Voting.createElection(candidateNames, root, start, end)` **on-chain** (via `cast`/`forge script`, not through this backend) with that root. This mints the on-chain `electionId` and emits `ElectionRegistered(electionId, root)`.
5. The backend's chain watcher (`src/chain.ts`) observes that event, matches its `root` back to the batch that produced it, and links them — `onChainElectionId` gets set, and candidates/timing get pulled from chain via `elections()`/`viewCandidateNames()`.
6. Each voter fetches `GET /elections/:batchId/merkle-proof/:commitment` to get the sibling path needed by the Noir circuit, using the now-known `onChainElectionId` for their nullifier and vote submission.

## Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- A deployed `Voting` contract to point `VOTING_ADDRESS` at (see the root README's "Contracts" section) — the server runs without one, but nothing ever links to an on-chain election.

## Install & run

```bash
cd implementation/backend
npm install
VOTING_ADDRESS=<voting-contract-address> npm run dev
```

Env vars:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `RPC_URL` | `http://localhost:8545` | Chain the watcher reads/watches |
| `VOTING_ADDRESS` | — (required for linking) | The deployed `Voting` contract |

Barretenberg WASM initialization takes a few seconds on first startup. Once running, the log shows `Watching <address> for ElectionRegistered events (N found already)` — the "found already" count is the watcher catching up on election history on startup, so restarting the backend doesn't lose previously-linked elections.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/elections` | Start a new registration batch. Returns `{ batchId }`. |
| `GET`  | `/elections` | List every known batch and its state. |
| `GET`  | `/elections/:batchId` | Single batch's state — `onChainElectionId`, `candidates`, `startTime`/`endTime` (once linked), `registrationClosed`, `registeredCount`, `root` (once closed). |
| `POST` | `/elections/:batchId/register` | Register a voter commitment against this batch. |
| `POST` | `/elections/:batchId/close-registration` | Finalise this batch's tree (idempotent). |
| `GET`  | `/elections/:batchId/merkle-proof/:commitment` | Fetch the Merkle proof for a commitment in this batch. |

All numeric values (commitments, hash paths, root, on-chain ids/timestamps) are decimal strings.

## Manual test sequence

Assumes a `Voting` contract is deployed and `VOTING_ADDRESS` points at it (see root README). Full command-by-command walkthrough, including the on-chain step, is in the root README's "Voting flow" section — this is the condensed version:

```bash
# 1. Start a batch
curl -s -X POST http://localhost:3000/elections
# → {"batchId":0}

# 2. Register a voter (known test-vector commitment for secret=3)
curl -s -X POST http://localhost:3000/elections/0/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"16285383130816713414875505228979288118031826271544080086166006549336213954567"}'
# → {"index":0}

# 3. Close registration — builds the Merkle tree
curl -s -X POST http://localhost:3000/elections/0/close-registration
# → {"root":"<decimal root>"}

# Calling it again is safe (idempotent)
curl -s -X POST http://localhost:3000/elections/0/close-registration
# → {"alreadyClosed":true,"root":"<same root>"}

# 4. Before the on-chain election exists, onChainElectionId is null:
curl -s http://localhost:3000/elections/0

# 5. Separately, on-chain: cast to-uint256 <root>, then
#    cast send <voting> "createElection(string[],bytes32,uint256,uint256)" \
#      "[Alice,Bob,Carol,Dave]" <root-hex> <start> <end> --private-key ... --rpc-url ...

# 6. A few seconds later, the batch is linked automatically:
curl -s http://localhost:3000/elections/0
# → onChainElectionId, candidates, startTime, endTime now populated

# 7. Fetch the Merkle proof
curl -s "http://localhost:3000/elections/0/merkle-proof/16285383130816713414875505228979288118031826271544080086166006549336213954567"
# → {"index":0,"hashPath":["0","...","...","...","...","..."],"root":"..."}

# 8. Error cases
# Register after close → 409
curl -s -X POST http://localhost:3000/elections/0/register -d '{"commitment":"999"}'
# Unknown batchId → 404
curl -s http://localhost:3000/elections/999
# Proof for unknown commitment → 404
curl -s "http://localhost:3000/elections/0/merkle-proof/99999"
```

For a second, concurrent election, just repeat from step 1 — each batch/election is independent.

## Testing tools (not part of the server)

- **`prove.ts`** — a Node stand-in for the not-yet-built browser voter client. Does the full voter-side flow in-process: computes a commitment, registers + closes (if needed), waits for the batch to be linked to an on-chain election, generates a real ZK proof (`noir_js` + `@aztec/bb.js`'s `UltraHonkBackend`), and submits `vote()` directly via `viem`. Configured entirely through env vars: `SECRET`, `VOTE`, `BATCH_ID`, `VOTING_ADDRESS`, `VOTER_PRIVATE_KEY`, `RPC_URL`, `BACKEND_URL`. Run with `npx tsx prove.ts`.
- **`test-voters.ts`** — generates deterministic `secret`/`commitment` pairs for a fixed list of test voter labels (`email:salt` → SHA-256 → reduced into the field), so you can track which secret belongs to which test identity across separate `prove.ts` runs. **Test-only** — deriving a real voter's secret from anything the backend/operator can also compute breaks the system's anonymity guarantee; see the file's own header comment. Run with `npx tsx test-voters.ts`.

## Architecture notes

### Hash correctness
All Pedersen hashing uses `@aztec/bb.js`'s `BarretenbergSync.pedersenHash({ inputs, hashIndex })`, which is byte-identical to Noir's `std::hash::pedersen_hash`. Verified against the circuit's `test_valid_proof` test vector (`secret=3` → the commitment used throughout this README and the test sequence above).

### Merkle path convention
The hash path returned by `/merkle-proof` follows the same indexing as the Noir circuit's `compute_root` function:
- `hashPath[k]` = sibling node at tree level `k` (0 = leaf level, 5 = one below root)
- Level `k` sibling index = `(leafIndex >> k) ^ 1`

This is consistent with `index.to_le_bits()` traversal in the circuit: bit `k` of the leaf index determines whether the current node is a left (`0`) or right (`1`) child at level `k`.

### Tree size
Depth 6 → 64 leaves per batch. Unused slots are padded with field element `0`. Each batch's tree is built once and is immutable after `close-registration` — registering more voters for the *next* election just means starting a new batch.

### `election_id` vs. `electionId`
The circuit's `election_id` public input, the nullifier's second argument, and `Voting.vote()`'s `electionId` parameter must all be the same value — the **on-chain** election array index (`onChainElectionId` from `GET /elections/:batchId`), not the backend's internal `batchId`. The two only happen to match if elections are created in exactly the same order the backend created batches in, which isn't guaranteed. Getting this wrong fails with `Voting.sol`'s `"Mismatch in elections chosen"` revert.

## Known limitations

- **No eligibility/authentication layer.** `POST /elections/:batchId/register` accepts any commitment from anyone — there's no check that the registrant is an authorized voter. This is a deliberate scope boundary: eligibility verification is a standard web-auth problem, orthogonal to the ZK/anonymity design this project focuses on. A production deployment would add an auth check in front of `/register` without needing to change how secrets/commitments/anonymity work.
- **Version pinning fragility.** `@aztec/bb.js` and `@noir-lang/noir_js` must exactly match the installed `bb`/`nargo` CLI versions — the ACIR/proof serialization formats aren't forward/backward compatible across releases, and a mismatch fails with an opaque WASM error, not a helpful one. Current pins: `@aztec/bb.js@5.0.0-nightly.20260324`, `@noir-lang/noir_js@1.0.0-beta.21`, matching `bb 5.0.0-nightly.20260324` / `nargo 1.0.0-beta.21`. Re-pin both together if you ever run `noirup`/`bbup`.
