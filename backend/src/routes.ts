import { Router, Request, Response } from 'express';
import { merkleTree } from './merkle.js';
import {
  ELECTION_ID,
  CANDIDATES,
  isRegistrationClosed,
  markRegistrationClosed,
} from './election.js';

export const router = Router();

// ---------------------------------------------------------------------------
// POST /register
// Body: { commitment: string }   (decimal or 0x-prefixed hex bigint)
// Returns: { index: number }
// ---------------------------------------------------------------------------
router.post('/register', (req: Request, res: Response) => {
  const { commitment } = req.body as { commitment?: string };

  if (!commitment || typeof commitment !== 'string') {
    res.status(400).json({ error: 'commitment field is required (string)' });
    return;
  }

  let comm: bigint;
  try {
    comm = BigInt(commitment);
  } catch {
    res.status(400).json({ error: 'commitment must be a valid decimal or 0x-prefixed hex integer' });
    return;
  }

  if (comm < 0n) {
    res.status(400).json({ error: 'commitment must be non-negative' });
    return;
  }

  try {
    const index = merkleTree.addLeaf(comm);
    res.json({ index });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(409).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /close-registration
// Builds the Merkle tree from current registrations.
// Idempotent: calling it when already closed returns { alreadyClosed: true }.
// Returns: { root: string }   (decimal string)
// ---------------------------------------------------------------------------
router.post('/close-registration', (req: Request, res: Response) => {
  if (merkleTree.isClosed) {
    res.json({ alreadyClosed: true, root: merkleTree.getRoot().toString() });
    return;
  }

  try {
    merkleTree.close();
    markRegistrationClosed();
    res.json({ root: merkleTree.getRoot().toString() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /merkle-proof/:commitment
// Returns: { index: number, hashPath: string[], root: string }
//          (all numeric values as decimal strings)
// ---------------------------------------------------------------------------
router.get('/merkle-proof/:commitment', (req: Request, res: Response) => {
  if (!merkleTree.isClosed) {
    res.status(409).json({ error: 'Registration is not closed yet — call POST /close-registration first' });
    return;
  }

  let comm: bigint;
  try {
    comm = BigInt(req.params.commitment);
  } catch {
    res.status(400).json({ error: 'commitment must be a valid decimal or 0x-prefixed hex integer' });
    return;
  }

  try {
    const { index, hashPath } = merkleTree.getMerkleProof(comm);
    res.json({
      index,
      hashPath: hashPath.map(n => n.toString()),
      root: merkleTree.getRoot().toString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /election-info
// Returns general election metadata and current state.
// ---------------------------------------------------------------------------
router.get('/election-info', (_req: Request, res: Response) => {
  const closed = merkleTree.isClosed;
  res.json({
    electionId: ELECTION_ID.toString(),
    candidates: CANDIDATES,
    registrationClosed: closed,
    registeredCount: merkleTree.registeredCount,
    ...(closed ? { root: merkleTree.getRoot().toString() } : {}),
  });
});
