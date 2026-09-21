# ZK E-Voting — Diploma Implementation

A zero-knowledge e-voting system where voters prove eligibility and cast ballots without revealing their identity. Built with Noir (ZK circuits), Solidity/Foundry (on-chain verification), and a TypeScript/Express backend (registration, Merkle proofs, and on-chain election indexing). Supports multiple concurrent elections.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Voter (browser — not yet built;           │
│                    prove.ts stands in for it during testing)  │
│  1. generate secret                                          │
│  2. compute commitment = pedersen_hash([secret])            │
│  3. fetch Merkle proof from backend                          │
│  4. generate ZK proof (noir_js + Barretenberg WASM)         │
│  5. submit proof to Voting contract                          │
└────────────┬───────────────────────────┬────────────────────┘
             │ register / get proof       │ vote(electionId, proof, publicInputs)
             ▼                            ▼
┌─────────────────────┐      ┌────────────────────────────────┐
│   Backend (Express) │◄─────┤     Contracts (Foundry/EVM)    │
│  - one Merkle tree   │      │  HonkVerifier  (generated)     │
│    per election batch│      │  Voting.sol    (app logic)      │
│  - watches on-chain  │      │  - elections[] (multi-election) │
│    ElectionRegistered│      └────────────────────────────────┘
│    events to link a  │  reads elections()/viewCandidateNames()
│    batch's root to   │  via viem, watches ElectionRegistered
│    its on-chain id   │
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
| `HonkVerifier` (`Verifier.sol`) | Auto-generated UltraHonk verifier for the Noir circuit. Verifies the ZK proof on-chain. Exceeds the EIP-170 24KB contract size limit — see "Contracts" below. |
| `Voting` (`Voting.sol`) | Application logic. `elections[]` is an array, so the contract supports any number of concurrent elections, each with its own Merkle root, candidates (created with `voteCount` fixed at `0` — the deployer can't seed results), timing window, and nullifier set. |

### Backend (`backend/`)
TypeScript/Express service with two jobs: running voter registration per election, and keeping a read-only cache of on-chain election data in sync via events.

Each registration round is a **batch** — its own Merkle tree, created before the election exists on-chain (the root has to exist *before* `createElection()` can be called with it). Once the owner calls `createElection()` on-chain with that root, the backend's chain watcher observes the resulting `ElectionRegistered(electionId, root)` event, matches it back to the batch that produced that root, and links the two — pulling candidates and timing from chain at that point. See `backend/README.md` for the full endpoint list and flow.

`backend/prove.ts` and `backend/test-voters.ts` are Node-based stand-ins for the not-yet-built browser voter client — they drive the same `noir_js` + `@aztec/bb.js` proof-generation path a real frontend would use, letting the whole flow be tested end-to-end without one.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [Nargo](https://noir-lang.org/docs/getting_started/installation/) | exactly `1.0.0-beta.21` | `curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install \| bash && noirup` |
| [Barretenberg (`bb`) CLI](https://noir-lang.org/docs/getting_started/installation/) | matching build, `5.0.0-nightly.20260324` | via `bbup`, or see `backend/README.md`'s version-pinning note |
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | bundled with Node.js |

**Version pinning matters here, non-obviously.** `nargo`, `bb`, and the backend's `@noir-lang/noir_js`/`@aztec/bb.js` npm packages all serialize ACIR bytecode and proofs in formats that change across releases — mixing versions fails either with a cryptic WASM `unreachable` trap or a "failed to deserialize circuit" error, not a helpful message. If you ever run `noirup`/`bbup` to update the CLIs, re-pin the backend's npm dependencies to match (see `backend/README.md`).

---

## Circuits

```bash
cd circuits
```

### Compile
```bash
nargo compile
# → target/circuts.json  (bytecode + ABI)
```

### Run tests
```bash
nargo test
# Runs test_valid_proof, test_wrong_secret_fails,
#        test_invalid_vote_value_fails, test_wrong_nullifier_fails,
#        test_wrong_root_fails
```

### Generate a proof (CLI)
`nargo prove`/`nargo verify` don't exist in this Nargo version — proving is a two-step, two-tool process now:
```bash
nargo execute my_witness          # compiles + runs the circuit against Prover.toml, writes the witness
bb prove -b target/circuts.json -w target/my_witness.gz -o target/ -t evm --write_vk
# → target/proof, target/public_inputs, target/vk
```
`-t evm` is required — it's what makes the proof's hash scheme (keccak) match the generated Solidity verifier; other targets produce an incompatible proof.

### Verify a proof (CLI)
```bash
bb verify -k target/vk -p target/proof -i target/public_inputs -t evm
```

For generating proofs programmatically (e.g. from the backend's test tooling) instead of via these CLI commands, see `backend/prove.ts`, which does the equivalent in-process with `noir_js` + `@aztec/bb.js`.

---

## Contracts

```bash
cd contracts
```

`foundry.toml` has two profiles because `Verifier.sol` (Noir-generated, contains inline assembly without memory-safe annotations) and `Voting.sol` used to have contradictory compiler requirements. `Voting.sol` no longer strictly needs it, but `Verifier.sol` still can't compile under `via_ir = true` — use `FOUNDRY_PROFILE=deploy` for anything that touches `Verifier.sol`.

### Build / test (default profile — skips `Verifier.sol`, tests use a mock verifier)
```bash
forge build
forge test -vv
```

### Start a local node
```bash
anvil --disable-code-size-limit
# HonkVerifier's deployed bytecode (~34KB) exceeds the 24KB EIP-170 limit that
# Anvil enforces by default — this flag is required for it to deploy locally.
```

### Deploy
```bash
FOUNDRY_PROFILE=deploy forge script script/Deployer.s.sol \
  --rpc-url http://localhost:8545 \
  --private-key <anvil-private-key> \
  --broadcast
```
This deploys `HonkVerifier` (auto-linking its `ZKTranscriptLib` external library) and `Voting`, but does **not** call `createElection()` — that happens per election, after a registration round exists in the backend and produces a root (see `backend/README.md`).

### Interact via cast
```bash
cast call <VOTING_ADDRESS> "getElectionCount()(uint256)" --rpc-url http://localhost:8545
```

---

## Backend

```bash
cd backend
npm install
VOTING_ADDRESS=<voting-address> npm run dev
# Barretenberg WASM initialises, then the chain watcher, then:
# → Voting backend listening on http://localhost:3000
```

`VOTING_ADDRESS` is required for the chain watcher to link registration batches to on-chain elections — without it, the server still runs, but `onChainElectionId` never gets set for anything. `RPC_URL` defaults to `http://localhost:8545`; override the port with `PORT=<n>`.

See `backend/README.md` for the full API and a step-by-step test sequence.

---

## Voting flow (end-to-end)

1. **A registration batch is created.** `POST /elections` → `{ batchId }`. Each batch has its own Merkle tree and no on-chain identity yet.
2. **Voters register.** Each generates a random `secret` locally, computes `commitment = pedersen_hash([secret])` (secret never leaves the client), and calls `POST /elections/:batchId/register`.
3. **Registration closes.** `POST /elections/:batchId/close-registration` pads to 64 leaves, builds the depth-6 Merkle tree, returns the root.
4. **The election goes on-chain.** The owner calls `Voting.createElection(candidateNames, root, start, end)` with that root. This mints the on-chain `electionId` and emits `ElectionRegistered(electionId, root)`.
5. **The backend auto-links.** Its event watcher matches the event's root back to the batch, records `onChainElectionId`, and fetches candidates/timing from chain.
6. **Voting phase.** Each voter fetches `{ index, hashPath, root }` from `GET /elections/:batchId/merkle-proof/:commitment`, computes `nullifier = pedersen_hash([secret, onChainElectionId])` locally, generates a ZK proof (`noir_js` + Barretenberg WASM — in a real browser, or via `prove.ts` for testing), and submits it to `Voting.vote(electionId, proof, publicInputs)`.
7. Contract calls `HonkVerifier`, checks the nullifier is unused and the root matches, increments the candidate's vote count.

---

## Project structure

```
implementation/
├── circuits/
│   ├── src/main.nr          # Noir ZK circuit
│   ├── target/               # Compiled artefacts (gitignored)
│   └── Nargo.toml
├── contracts/
│   ├── src/
│   │   ├── Verifier.sol      # Generated HonkVerifier
│   │   ├── IVerifier.sol     # Verifier interface used by Voting
│   │   └── Voting.sol        # Application logic — multi-election
│   ├── script/
│   │   └── Deployer.s.sol    # Deploys HonkVerifier + Voting
│   ├── test/Voting.t.sol
│   ├── lib/forge-std/        # Foundry standard library
│   └── foundry.toml          # Two profiles — see "Contracts" above
└── backend/
    ├── src/
    │   ├── index.ts          # Express entry point + starts the chain watcher
    │   ├── routes.ts         # /elections API endpoints
    │   ├── merkle.ts         # MerkleTree class + Barretenberg hashing
    │   ├── election.ts       # Per-batch election store, chain-event linking
    │   └── chain.ts          # viem client: reads + watches the Voting contract
    ├── prove.ts               # Node stand-in for a browser voter: proof gen + vote submission
    ├── test-voters.ts         # Deterministic test-voter secret/commitment generator
    ├── package.json
    └── tsconfig.json
```
