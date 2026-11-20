import { failPendingClaims } from '../db.js';

// Run once after restoring the database from a backup, with the faucet stopped (docs/CKBOLT-DEPLOY.md, restore step).
const changed = failPendingClaims();
console.log(`Marked ${changed} queued or processing claim(s) as failed.`);
