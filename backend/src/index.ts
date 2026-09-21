import express from 'express';
import cors from 'cors';
import { initBarretenberg } from './merkle.js';
import { router } from './routes.js';
import { watchElectionRegistrations } from './chain.js';
import { linkBatchToChain } from './election.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function main() {
  console.log('Initializing Barretenberg WASM...');
  await initBarretenberg();
  console.log('Barretenberg ready.');

  // Links registration batches to their on-chain election as ElectionRegistered
  // events are observed. No-ops (with a warning) if VOTING_ADDRESS isn't set.
  await watchElectionRegistrations((electionId, root) => {
    linkBatchToChain(electionId, root).catch(err => console.error('Failed to link batch:', err));
  });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(router);

  app.listen(PORT, () => {
    console.log(`Voting backend listening on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
