# ZK E-Voting — Diploma Implementation

A zero-knowledge e-voting system where voters prove eligibility and cast ballots without revealing their identity. Built with Noir (ZK circuits), Solidity/Foundry (on-chain verification), and a TypeScript/Express backend (registration & Merkle proofs).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Voter (browser)                       │
│  1. generate secret                                          │
│  2. compute commitment = pedersen_hash([secret])            │
│  3. fetch Merkle proof from backend                          │
│  4. generate ZK proof (noir_js + Barretenberg WASM)         │
│  5. submit proof to Voting contract                          │
└────────────┬───────────────────────────┬────────────────────┘
             │ register / get proof       │ castVote(proof)
             ▼                            ▼
┌─────────────────────┐      ┌────────────────────────────────┐
│   Backend (Express) │      │     Contracts (Foundry/EVM)    │
│  - voter registry   │      │  HonkVerifier  (generated)     │
│  - Merkle tree      │      │  Voting.sol    (app logic)      │
│  - proof data API   │      └────────────────────────────────┘
└─────────────────────┘
         ▲
   compiled from
         │
┌─────────────────────┐
│   Circuits (Noir)   │
│  - eligibility      │
│  - nullifier        │
│  - vote range       │
└─────────────────────┘
```

## What is implemented

### Circuits (`circuits/`)
Noir circuit that proves, in zero-knowledge, that a voter:
- **Is registered** — their `leaf = pedersen_hash([secret])` is a member of the Merkle tree (via a 6-level Pedersen Merkle proof).
- **Has not voted before** — computes a unique `nullifier = pedersen_hash([secret, election_id])` that the contract stores to prevent double-voting.
- **Cast a valid choice** — `vote < 4` (four candidates, indices 0–3).

The circuit has **no public inputs that reveal the voter's secret**. Only `vote`, `election_id`, `root`, and `nullifier` are public.

Public inputs: `vote`, `election_id`, `root`, `nullifier`  
Private inputs: `secret`, `index`, `hash_path[6]`

### Contracts (`contracts/`)
Two Solidity contracts compiled and tested with Foundry:

| Contract | Description |
|---|---|
| `HonkVerifier` (`Verifier.sol`) | Auto-generated UltraHonk verifier for the Noir circuit. Verifies the ZK proof on-chain. |
| `Voting` (`Voting.sol`) | Application logic — stores proposals, tracks nullifiers, calls the verifier, tallies votes. |

### Backend (`backend/`)
TypeScript/Express service that runs during the registration phase:

| Endpoint | Description |
|---|---|
| `POST /register` | Accept a voter's commitment and assign a leaf index |
| `POST /close-registration` | Pad to 64 leaves, build the Pedersen Merkle tree, publish the root |
| `GET /merkle-proof/:commitment` | Return `{ index, hashPath[6], root }` for a registered voter |
| `GET /election-info` | Return election ID, candidate list, and current state |

All Pedersen hashing uses `@aztec/bb.js` (`BarretenbergSync`), which is byte-identical to Noir's `std::hash::pedersen_hash`. Verified against the circuit test vector before deployment.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [Nargo](https://noir-lang.org/docs/getting_started/installation/) | ≥ 1.0 | `curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install \| bash && noirup` |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | bundled with Node.js |

---

## Circuits

```bash
cd circuits
```

### Compile
```bash
nargo compile
# → target/circuts.json  (bytecode)
# → target/circuts.gz
```

### Run tests
```bash
nargo test
# Runs test_valid_proof, test_wrong_secret_fails,
#        test_invalid_vote_value_fails, test_wrong_nullifier_fails,
#        test_wrong_root_fails
```

### Generate a proof (CLI)
Edit `Prover.toml` with your inputs, then:
```bash
nargo execute
# → target/proof
```

### Verify a proof (CLI)
```bash
nargo verify
```

### Export verification key
```bash
bb write_vk -b target/circuts.json -o target/vk
```

---

## Contracts

```bash
cd contracts
```

### Build
```bash
forge build
# → out/
```

### Test
```bash
forge test -vv
```

### Start a local node
```bash
anvil
# Starts a local EVM node at http://localhost:8545
# Prints 10 funded test accounts and their private keys
```

### Deploy to local node
```bash
forge script script/<ScriptName>.s.sol \
  --rpc-url http://localhost:8545 \
  --private-key <anvil-private-key> \
  --broadcast
```

### Interact via cast
```bash
# Example: read proposal count
cast call <CONTRACT_ADDRESS> "getProposalCount()(uint256)" \
  --rpc-url http://localhost:8545
```

---

## Backend

```bash
cd backend
npm install
npm run dev
# Barretenberg WASM initialises, then:
# → Voting backend listening on http://localhost:3000
```

Override the default port with `PORT=<n> npm run dev`.

### Quick smoke test

```bash
# 1. Election state before any registration
curl http://localhost:3000/election-info

# 2. Register voters (each voter submits their own precomputed commitment)
curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"commitment":"16285383130816713414875505228979288118031826271544080086166006549336213954567"}'
# → {"index":0}

# 3. Close registration — builds the Merkle tree
curl -s -X POST http://localhost:3000/close-registration
# → {"root":"<decimal root>"}

# 4. Fetch Merkle proof for a registered voter
curl -s "http://localhost:3000/merkle-proof/16285383130816713414875505228979288118031826271544080086166006549336213954567"
# → {"index":0,"hashPath":["...","...","...","...","...","..."],"root":"..."}

# 5. Election info after close (includes root)
curl http://localhost:3000/election-info
```

---

## Voting flow (end-to-end)

1. **Registration phase**
   - Each voter generates a random `secret` locally.
   - Computes `commitment = pedersen_hash([secret])` (client-side, secret never leaves the browser).
   - Calls `POST /register` with the commitment.

2. **Tree finalisation**
   - Admin calls `POST /close-registration`.
   - Backend pads to 64 leaves, builds the depth-6 Merkle tree, returns the root.
   - Admin stores the root in the `Voting` contract.

3. **Voting phase**
   - Voter fetches their `{ index, hashPath, root }` from `GET /merkle-proof/:commitment`.
   - Voter computes `nullifier = pedersen_hash([secret, election_id])` locally.
   - Voter generates a ZK proof via `noir_js` + Barretenberg WASM in the browser.
   - Voter submits the proof to the `Voting` contract.
   - Contract calls `HonkVerifier`, checks the nullifier is unused, increments the candidate's vote count.

---

## Project structure

```
implementation/
├── circuits/
│   ├── src/main.nr          # Noir ZK circuit
│   ├── target/              # Compiled artefacts (gitignored)
│   └── Nargo.toml
├── contracts/
│   ├── src/
│   │   ├── Verifier.sol     # Generated HonkVerifier
│   │   └── Voting.sol       # Application logic
│   ├── lib/forge-std/       # Foundry standard library
│   └── foundry.toml
├── backend/
│   ├── src/
│   │   ├── index.ts         # Express entry point
│   │   ├── routes.ts        # API endpoints
│   │   ├── merkle.ts        # Merkle tree + Barretenberg hashing
│   │   └── election.ts      # Election constants
│   ├── package.json
│   └── tsconfig.json
└── scripts/
    └── Script.ts
```
