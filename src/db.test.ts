import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

// Test environment, set before src/config.ts loads: no .env file, an in-memory claims database and the CKBolt default
// limits (address cooldown 24 h, IP cooldown 30 min, daily caps 1 per address, 3 per network, 50 in total).
const NO_ENV_FILE = join(tmpdir(), 'cwbtc-faucet-test-no-such.env');
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: NO_ENV_FILE,
  DATABASE_PATH: ':memory:',
  CKB_RPC_URL: 'http://127.0.0.1:9/',
  ADDRESS_COOLDOWN_SECONDS: '86400',
  IP_COOLDOWN_SECONDS: '1800',
  ADDRESS_DAILY_CLAIM_LIMIT: '1',
  IP_DAILY_CLAIM_LIMIT: '3',
  GLOBAL_DAILY_CLAIM_LIMIT: '50',
});

const {
  RESTORE_FAILED_ERROR,
  adminSummary,
  countClaims,
  db,
  failPendingClaims,
  getClaim,
  getNextWorkClaim,
  hasActiveClaim,
  insertClaim,
  latestClaimForAddress,
  latestClaimForIpSince,
  markClaimStatus,
} = await import('./db.js');
const { checkClaimEligibility } = await import('./security.js');
type ClaimStatus = import('./db.js').ClaimStatus;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CREATED = 1_700_000_000_000;
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/** Empties the claims table and inserts one claim per status (sent and confirmed with a tx hash, failed with an error). */
function seed(statuses: ClaimStatus[]): void {
  db.exec('DELETE FROM claims');
  statuses.forEach((status, i) => {
    const id = `${status}-${i}`;
    insertClaim({
      id,
      address: `ckt1-test-address-${i}`,
      ip_hash: `ip-${i}`,
      amount_raw: '1000000',
      status: 'queued',
      user_agent: null,
      created_at: CREATED + i,
      updated_at: CREATED + i,
      cooldown_until: CREATED + i + 86_400_000,
    });
    if (status === 'queued') return;
    const txHash = status === 'sent' || status === 'confirmed' ? TX(i + 1) : null;
    markClaimStatus(id, status, txHash, status === 'failed' ? 'earlier worker error' : null);
    db.prepare('UPDATE claims SET updated_at = ? WHERE id = ?').run(CREATED + i, id);
  });
}

function rows(): Array<{ id: string; status: string; tx_hash: string | null; error: string | null; updated_at: number }> {
  return db.prepare('SELECT id, status, tx_hash, error, updated_at FROM claims ORDER BY id').all() as never;
}

test('RESTORE_FAILED_ERROR tells the user the claim was not sent and to claim again', () => {
  assert.equal(RESTORE_FAILED_ERROR, 'Not sent: the faucet database was restored from a backup. Please claim again.');
});

test('failPendingClaims marks queued and processing claims failed, leaves sent, confirmed and failed ones alone', () => {
  seed(['queued', 'processing', 'sent', 'confirmed', 'failed', 'queued']);
  const before = new Map(rows().map((row) => [row.id, row]));

  assert.equal(failPendingClaims(CREATED + 1_000), 3);

  for (const id of ['queued-0', 'processing-1', 'queued-5']) {
    const { status, error, tx_hash, updated_at } = getClaim(id)!;
    assert.deepEqual(
      { status, error, tx_hash, updated_at },
      { status: 'failed', error: RESTORE_FAILED_ERROR, tx_hash: null, updated_at: CREATED + 1_000 },
      id,
    );
  }
  for (const id of ['sent-2', 'confirmed-3', 'failed-4']) {
    assert.deepEqual(rows().find((row) => row.id === id), before.get(id), id);
  }
  assert.equal(getClaim('sent-2')!.tx_hash, TX(3));
  assert.equal(getClaim('failed-4')!.error, 'earlier worker error');
});

test('failPendingClaims keeps the other columns of the claims it fails', () => {
  seed(['queued']);
  const before = getClaim('queued-0')!;
  failPendingClaims(CREATED + 5);
  const after = getClaim('queued-0')!;
  assert.deepEqual(
    { ...after, status: before.status, error: before.error, updated_at: before.updated_at },
    before,
  );
});

test('failPendingClaims returns 0 when nothing is pending, and a second run changes nothing', () => {
  db.exec('DELETE FROM claims');
  assert.equal(failPendingClaims(), 0);

  seed(['queued', 'processing', 'sent']);
  assert.equal(failPendingClaims(CREATED + 10), 2);
  const after = rows();
  assert.equal(failPendingClaims(CREATED + 20), 0);
  assert.deepEqual(rows(), after);
});

test('failPendingClaims uses the current time by default', () => {
  seed(['queued']);
  const start = Date.now();
  failPendingClaims();
  const updated = getClaim('queued-0')!.updated_at;
  assert.ok(updated >= start && updated <= Date.now(), String(updated));
});

test('after failPendingClaims the worker only has the sent claim left to confirm, and nothing to send', () => {
  seed(['queued', 'processing', 'sent']);
  failPendingClaims(CREATED + 1);
  assert.equal(getNextWorkClaim()?.id, 'sent-2');
  markClaimStatus('sent-2', 'confirmed', TX(3));
  assert.equal(getNextWorkClaim(), undefined);
  assert.equal(hasActiveClaim('ckt1-test-address-0'), false);
  assert.equal(hasActiveClaim('ckt1-test-address-1'), false);
});

test('npm run claims:fail-pending (src/cli/fail-pending-claims.ts) fails the pending claims of the database file', () => {
  seed(['queued', 'processing', 'sent', 'confirmed', 'failed']);
  const dir = mkdtempSync(join(tmpdir(), 'cwbtc-faucet-test-'));
  const file = join(dir, 'faucet.sqlite');
  try {
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);

    const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: NO_ENV_FILE, DATABASE_PATH: file };
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/fail-pending-claims.ts'], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), 'Marked 2 queued or processing claim(s) as failed.');

    const restored = new Database(file, { readonly: true });
    try {
      const statuses = restored.prepare('SELECT id, status, error, tx_hash FROM claims ORDER BY id').all();
      assert.deepEqual(statuses, [
        { id: 'confirmed-3', status: 'confirmed', error: null, tx_hash: TX(4) },
        { id: 'failed-4', status: 'failed', error: 'earlier worker error', tx_hash: null },
        { id: 'processing-1', status: 'failed', error: RESTORE_FAILED_ERROR, tx_hash: null },
        { id: 'queued-0', status: 'failed', error: RESTORE_FAILED_ERROR, tx_hash: null },
        { id: 'sent-2', status: 'sent', error: null, tx_hash: TX(3) },
      ]);
    } finally {
      restored.close();
    }

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), 'Marked 0 queued or processing claim(s) as failed.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Claims failed by failPendingClaims count for no limit; every other failed claim still counts.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Inserts a queued claim. `ageMs`: how long ago it was made. `cooldownLeftMs`: how long its address cooldown still runs. */
function addClaim(id: string, address: string, ipHash: string, ageMs: number, cooldownLeftMs: number): void {
  const now = Date.now();
  insertClaim({
    id,
    address,
    ip_hash: ipHash,
    amount_raw: '1000000',
    status: 'queued',
    user_agent: null,
    created_at: now - ageMs,
    updated_at: now - ageMs,
    cooldown_until: now + cooldownLeftMs,
  });
}

type FailKind = 'restore' | 'worker error' | 'no error';

/** Fails every queued claim: by failPendingClaims (restore), or as the worker does (with its error, or with none). */
function failQueued(kind: FailKind): void {
  if (kind === 'restore') {
    failPendingClaims();
    return;
  }
  const ids = db.prepare("SELECT id FROM claims WHERE status = 'queued'").all() as Array<{ id: string }>;
  for (const { id } of ids) markClaimStatus(id, 'failed', null, kind === 'worker error' ? 'CKB transaction rejected: test' : null);
}

/** Each limit: the claims that hit it, and the claim (address, network) it then refuses with `refusal`. */
const LIMITS: Array<{ name: string; setup: () => void; address: string; ipHash: string; refusal: RegExp }> = [
  {
    name: 'the pending claim and the address cooldown',
    setup: () => addClaim('a1', 'addr-A', 'net-1', 0, DAY),
    address: 'addr-A',
    ipHash: 'net-2',
    refusal: /^This address (already has a pending claim|can claim again in 24 h)$/,
  },
  {
    name: 'the IP cooldown',
    setup: () => addClaim('a1', 'addr-A', 'net-1', 0, DAY),
    address: 'addr-B',
    ipHash: 'net-1',
    refusal: /^This network can claim again in 30 min$/,
  },
  {
    name: 'the daily cap per address',
    setup: () => addClaim('a1', 'addr-A', 'net-1', 2 * HOUR, -1),
    address: 'addr-A',
    ipHash: 'net-2',
    refusal: /^This address has reached the daily claim limit$/,
  },
  {
    name: 'the daily cap per network',
    setup: () => {
      for (let i = 0; i < 3; i += 1) addClaim(`n${i}`, `addr-n${i}`, 'net-1', 2 * HOUR, -1);
    },
    address: 'addr-B',
    ipHash: 'net-1',
    refusal: /^This network has reached the daily claim limit$/,
  },
  {
    name: 'the global daily cap',
    setup: () => {
      for (let i = 0; i < 50; i += 1) addClaim(`g${i}`, `addr-g${i}`, `net-g${i}`, 2 * HOUR, -1);
    },
    address: 'addr-B',
    ipHash: 'net-B',
    refusal: /^The faucet has reached the global daily claim limit$/,
  },
];

for (const limit of LIMITS) {
  test(`a claim failed by failPendingClaims does not count for ${limit.name}`, () => {
    db.exec('DELETE FROM claims');
    limit.setup();
    assert.notEqual(checkClaimEligibility(limit.address, limit.ipHash), null, 'refused while the claim is queued');
    failQueued('restore');
    assert.equal(checkClaimEligibility(limit.address, limit.ipHash), null);
  });

  test(`a claim the worker failed still counts for ${limit.name}`, () => {
    for (const kind of ['worker error', 'no error'] as const) {
      db.exec('DELETE FROM claims');
      limit.setup();
      failQueued(kind);
      assert.match(checkClaimEligibility(limit.address, limit.ipHash) ?? '', limit.refusal, kind);
    }
  });
}

test('the limit queries skip restore-failed claims and still find the counted ones', () => {
  db.exec('DELETE FROM claims');
  const now = Date.now();
  addClaim('old', 'addr-A', 'net-1', 3 * HOUR, DAY - 3 * HOUR);
  addClaim('worker', 'addr-A', 'net-1', 2 * HOUR, DAY - 2 * HOUR);
  markClaimStatus('worker', 'failed', null, 'CKB transaction rejected: test');
  markClaimStatus('old', 'confirmed', TX(1));
  addClaim('restored', 'addr-A', 'net-1', HOUR, DAY - HOUR);
  failPendingClaims();
  assert.equal(getClaim('restored')!.error, RESTORE_FAILED_ERROR);

  assert.equal(latestClaimForAddress('addr-A')?.id, 'worker', 'the newest counted claim, not the restore-failed one');
  assert.equal(latestClaimForIpSince('net-1', now - DAY)?.id, 'worker');
  assert.equal(latestClaimForIpSince('net-1', now - 90 * 60_000), undefined, 'only the restore-failed claim is that recent');
  assert.equal(countClaims('address = ? AND created_at >= ?', ['addr-A', now - DAY]), 2);
  assert.equal(countClaims('created_at >= ?', [now - DAY]), 2);
  // The caller's condition is kept apart from the exclusion: an OR in it does not bring restore-failed claims back.
  assert.equal(countClaims('address = ? OR ip_hash = ?', ['addr-A', 'net-1']), 2);
  assert.equal(countClaims("status = 'failed' OR address = ?", ['addr-A']), 2);
});

test('only a failed claim with exactly RESTORE_FAILED_ERROR is skipped', () => {
  db.exec('DELETE FROM claims');
  addClaim('similar', 'addr-A', 'net-1', 0, DAY);
  markClaimStatus('similar', 'failed', null, `${RESTORE_FAILED_ERROR} `);
  addClaim('sent', 'addr-B', 'net-2', 0, DAY);
  // A claim in another status that carries the same error text (not something the faucet writes) still counts.
  markClaimStatus('sent', 'sent', TX(2), RESTORE_FAILED_ERROR);
  assert.equal(latestClaimForAddress('addr-A')?.id, 'similar');
  assert.equal(latestClaimForAddress('addr-B')?.id, 'sent');
  assert.equal(countClaims('1 = 1', []), 2);
});

test('restore-failed claims are still listed in the admin summary', () => {
  db.exec('DELETE FROM claims');
  addClaim('a1', 'addr-A', 'net-1', 0, DAY);
  addClaim('a2', 'addr-B', 'net-1', 0, DAY);
  failPendingClaims();
  const summary = adminSummary() as { byStatus: Array<{ status: string; count: number }>; lastClaims: Array<{ error: string }> };
  assert.deepEqual(summary.byStatus, [{ status: 'failed', count: 2 }]);
  assert.deepEqual(
    summary.lastClaims.map((claim) => claim.error),
    [RESTORE_FAILED_ERROR, RESTORE_FAILED_ERROR],
  );
});
