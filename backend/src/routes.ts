import { Router, Request, Response } from 'express';
import { createBatch, getBatch, listBatches, ElectionBatch } from './election.js';

export const router = Router();

function parseBatchId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function batchInfo(b: ElectionBatch) {
  const closed = b.tree.isClosed;
  return {
    batchId: b.batchId,
    onChainElectionId: b.onChainElectionId?.toString() ?? null,
    candidates: b.candidates ?? null,
    startTime: b.startTime?.toString() ?? null,
    endTime: b.endTime?.toString() ?? null,
    registrationClosed: closed,
    registeredCount: b.tree.registeredCount,
    ...(closed ? { root: b.tree.getRoot().toString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// POST /elections
// Starts a new registration batch. Returns its batchId — call createElection()
// on-chain with the root you get from close-registration below, and the batch
// will auto-link to whatever on-chain electionId that produces.
// Returns: { batchId: number }
// ---------------------------------------------------------------------------
router.post('/elections', (_req: Request, res: Response) => {
  const batch = createBatch();
  res.json({ batchId: batch.batchId });
});

// ---------------------------------------------------------------------------
// GET /elections
// Lists every known batch and its current state (linked or not).
// ---------------------------------------------------------------------------
router.get('/elections', (_req: Request, res: Response) => {
  res.json(listBatches().map(batchInfo));
});

// ---------------------------------------------------------------------------
// GET /elections/:batchId
// ---------------------------------------------------------------------------
router.get('/elections/:batchId', (req: Request, res: Response) => {
  const batchId = parseBatchId(req.params.batchId);
  const batch = batchId === null ? undefined : getBatch(batchId);
  if (!batch) {
    res.status(404).json({ error: 'Unknown batchId' });
    return;
  }
  res.json(batchInfo(batch));
});

// ---------------------------------------------------------------------------
// POST /elections/:batchId/register
// Body: { commitment: string }   (decimal or 0x-prefixed hex bigint)
// Returns: { index: number }
// ---------------------------------------------------------------------------
router.post('/elections/:batchId/register', (req: Request, res: Response) => {
  const batchId = parseBatchId(req.params.batchId);
  const batch = batchId === null ? undefined : getBatch(batchId);
  if (!batch) {
    res.status(404).json({ error: 'Unknown batchId' });
    return;
  }

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
    const index = batch.tree.addLeaf(comm);
    res.json({ index });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(409).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /elections/:batchId/close-registration
// Builds the Merkle tree from current registrations in this batch.
// Idempotent: calling it when already closed returns { alreadyClosed: true }.
// Returns: { root: string }   (decimal string)
// ---------------------------------------------------------------------------
router.post('/elections/:batchId/close-registration', (req: Request, res: Response) => {
  const batchId = parseBatchId(req.params.batchId);
  const batch = batchId === null ? undefined : getBatch(batchId);
  if (!batch) {
    res.status(404).json({ error: 'Unknown batchId' });
    return;
  }

  if (batch.tree.isClosed) {
    res.json({ alreadyClosed: true, root: batch.tree.getRoot().toString() });
    return;
  }

  try {
    batch.tree.close();
    res.json({ root: batch.tree.getRoot().toString() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /elections/:batchId/merkle-proof/:commitment
// Returns: { index: number, hashPath: string[], root: string }
// ---------------------------------------------------------------------------
router.get('/elections/:batchId/merkle-proof/:commitment', (req: Request, res: Response) => {
  const batchId = parseBatchId(req.params.batchId);
  const batch = batchId === null ? undefined : getBatch(batchId);
  if (!batch) {
    res.status(404).json({ error: 'Unknown batchId' });
    return;
  }

  if (!batch.tree.isClosed) {
    res.status(409).json({ error: 'Registration is not closed yet — call POST /elections/:batchId/close-registration first' });
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
    const { index, hashPath } = batch.tree.getMerkleProof(comm);
    res.json({
      index,
      hashPath: hashPath.map(n => n.toString()),
      root: batch.tree.getRoot().toString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});
