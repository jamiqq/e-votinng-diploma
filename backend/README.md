# Voting Backend

TypeScript/Express service that manages voter registration and serves Merkle proof data for the ZK e-voting system.

## Overview

The flow is:
1. Voters call `POST /register` with their commitment (`pedersen_hash([secret])`). The **secret is never sent to the backend** — only the commitment.
2. An admin calls `POST /close-registration` once all voters have registered. This pads the leaf array to 64 entries with `0` and builds the depth-6 Pedersen Merkle tree.
3. Each voter fetches their `GET /merkle-proof/:commitment` to get the sibling path needed by the Noir circuit.
4. The frontend uses `GET /election-info` to learn the election ID, candidate list, and Merkle root.

## Prerequisites

- Node.js ≥ 18
- npm ≥ 9

## Install & run

```bash
cd implementation/backend
npm install
npm run dev
```

The server starts on `http://localhost:3000` (override with `PORT=<n>` environment variable).

Barretenberg WASM initialization takes a few seconds on first startup — wait for the log line `Voting backend listening on http://localhost:3000`.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register a voter commitment |
| `POST` | `/close-registration` | Finalise the tree (idempotent) |
| `GET`  | `/merkle-proof/:commitment` | Fetch Merkle proof for a commitment |
| `GET`  | `/election-info` | Election metadata and current state |

All numeric values (commitments, hash paths, root) are decimal strings.

## Manual test sequence

The commands below walk through a complete flow: three registrations, closing, and fetching a proof.

```bash
# 1. Check initial state
curl http://localhost:3000/election-info

# 2. Register three voters
#    Each voter computes pedersen_hash([secret]) client-side and sends only the commitment.
#    Here we use arbitrary commitment values for illustration.
curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"11111111111111111111111111111111111111111111111111111111111111111"}'
# → {"index":0}

curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"22222222222222222222222222222222222222222222222222222222222222222"}'
# → {"index":1}

# Use the known commitment for secret=3 (from the circuit test vector)
curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"16285383130816713414875505228979288118031826271544080086166006549336213954567"}'
# → {"index":2}

# 3. Close registration — builds the Merkle tree
curl -s -X POST http://localhost:3000/close-registration
# → {"root":"<decimal root>"}

# Calling it again is safe (idempotent)
curl -s -X POST http://localhost:3000/close-registration
# → {"alreadyClosed":true,"root":"<same root>"}

# 4. Fetch the Merkle proof for voter 2
curl -s "http://localhost:3000/merkle-proof/16285383130816713414875505228979288118031826271544080086166006549336213954567"
# → {"index":2,"hashPath":["0","...","...","...","...","..."],"root":"..."}

# 5. Verify error cases
# Attempt to register after close → 409
curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"999"}'

# Fetch proof for unknown commitment → 404
curl -s "http://localhost:3000/merkle-proof/99999"
```

## Architecture notes

### Hash correctness
All Pedersen hashing uses `@aztec/bb.js` `BarretenbergSync.pedersenHash(inputs, hashIndex=0)`, which is byte-identical to Noir's `std::hash::pedersen_hash`. This was verified against the circuit's `test_valid_proof` test vector before implementation.

### Merkle path convention
The hash path returned by `/merkle-proof` follows the same indexing as the Noir circuit's `compute_root` function:
- `hashPath[k]` = sibling node at tree level `k` (0 = leaf level, 5 = one below root)
- Level `k` sibling index = `(leafIndex >> k) ^ 1`

This is consistent with `index.to_le_bits()` traversal in the circuit: bit `k` of the leaf index determines whether the current node is a left (`0`) or right (`1`) child at level `k`.

### Tree size
Depth 6 → 64 leaves. Unused slots are padded with field element `0`. The root therefore changes if more voters register in a later session — but this design is closed-registration (tree built once, root immutable during voting).

## Correctness flag

One known area of fragility: if the Noir circuit is recompiled with a different version of the Barretenberg backend, the Pedersen hash outputs can differ. Always re-verify the test vector (`secret=3, index=2, root=13477193...`) when upgrading `@aztec/bb.js` or regenerating the circuit artefacts.
