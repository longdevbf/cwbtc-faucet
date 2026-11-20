import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { ccc } from '@ckb-ccc/core';
import express, { type ErrorRequestHandler } from 'express';

// Test environment, set before src/config.ts loads: no .env file, an in-memory claims database, an unreachable RPC URL,
// a throwaway hot-wallet key (never funded, never used on a chain), no Turnstile and the CKBolt default limits.
const RPC_URL = 'http://127.0.0.1:9/';
const ADMIN_TOKEN = 'routes-test-admin-token-0123456789';
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: join(tmpdir(), 'cwbtc-faucet-test-no-such.env'),
  DATABASE_PATH: ':memory:',
  CKB_RPC_URL: RPC_URL,
  FAUCET_PRIVATE_KEY: `0x${randomBytes(32).toString('hex')}`,
  WORKER_ENABLED: 'true',
  REQUIRE_TURNSTILE: 'false',
  ADMIN_TOKEN,
  IP_HASH_SALT: 'routes-test-salt',
  ADDRESS_COOLDOWN_SECONDS: '86400',
  IP_COOLDOWN_SECONDS: '1800',
  ADDRESS_DAILY_CLAIM_LIMIT: '1',
  IP_DAILY_CLAIM_LIMIT: '3',
  GLOBAL_DAILY_CLAIM_LIMIT: '50',
  BALANCE_CACHE_SECONDS: '60',
});
for (const name of ['FAUCET_PRIVATE_KEY_FILE', 'ADMIN_TOKEN_FILE', 'IP_HASH_SALT_FILE']) delete process.env[name];

// No CKB RPC through ccc: every JSON-RPC request of a ccc client fails here instead of reaching any network.
const cccRequests = mock.method(ccc.RequestorJsonRpc.prototype, 'request', async (method: string) => {
  throw new Error(`test: no CKB RPC (${method})`);
});

// src/ckb/rpc.ts calls the global fetch for /api/balance: answer the RPC URL with an empty wallet, pass the rest through
// (the test's own requests to the local server).
const realFetch = globalThis.fetch;
let rpcFetches = 0;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) === RPC_URL) {
    rpcFetches += 1;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: [], last_cursor: '0x00' } }));
  }
  return realFetch(input, init);
});

const { default: router } = await import('./routes.js');
const { db, failPendingClaims, markClaimStatus } = await import('./db.js');
const { clientNetwork, hashIp } = await import('./security.js');
const { RECIPIENT_LOCK_MESSAGE } = await import('./ckb/recipient.js');

// The app as src/index.ts builds it (without the worker, the static page or a public port).
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(router);
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(500).json({ ok: false, message: err instanceof Error ? err.message : 'Internal server error' });
};
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const testnet = new ccc.ClientPublicTestnet({ url: RPC_URL });
const SECP = { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type' } as const;
const JOYID = { codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac', hashType: 'type' } as const;
const address = (lock: { codeHash: string; hashType: 'type' }, args: string) =>
  ccc.Address.fromScript({ ...lock, args }, testnet).toString();
/** A fresh standard testnet address. */
let addressSeq = 0;
const newAddress = () => address(SECP, `0x${(++addressSeq).toString(16).padStart(40, '0')}`);

interface ApiResponse {
  status: number;
  type: string | null;
  body: { ok?: boolean; message?: string; address?: string; status?: string } & Record<string, unknown>;
}

/** POST /api/claims as a client behind the one trusted proxy: `ip` arrives in X-Forwarded-For. */
async function claim(recipient: unknown, ip: string): Promise<ApiResponse> {
  const res = await fetch(`${BASE}/api/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ address: recipient }),
  });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}

const claimCount = () => (db.prepare('SELECT COUNT(*) AS count FROM claims').get() as { count: number }).count;

// ---------------------------------------------------------------------------------------------------------------------
// F1: long-args and other refused recipients

test('a claim for a long-args standard address is refused with 400 and a plain message, and nothing is queued', async () => {
  const before = claimCount();
  const res = await claim(address(SECP, `0x${'ab'.repeat(580)}`), '192.0.2.10');
  assert.equal(res.status, 400);
  assert.match(res.type ?? '', /^application\/json/);
  assert.deepEqual(res.body, {
    ok: false,
    message:
      'This standard CKB address has 580 bytes of lock args; the faucet only sends to standard CKB addresses with 20. ' +
      'Copy the address from your wallet again.',
  });
  assert.equal(claimCount(), before);
});

test('a claim for a JoyID address with other than 22 bytes of args is refused with 400', async () => {
  for (const args of [`0x0001${'cd'.repeat(21)}`, `0x0001${'cd'.repeat(200)}`, `0x0001${'cd'.repeat(18)}`]) {
    const res = await claim(address(JOYID, args), '192.0.2.11');
    assert.equal(res.status, 400, args);
    assert.equal(res.body.ok, false);
    assert.match(res.body.message ?? '', /^This JoyID address has \d+ bytes of lock args; .* with 22\. /);
  }
});

test('other refused recipients get 400 with their own plain message', async () => {
  const cases: Array<[unknown, string]> = [
    [address({ codeHash: `0x${'11'.repeat(32)}`, hashType: 'type' }, `0x${'ab'.repeat(20)}`), RECIPIENT_LOCK_MESSAGE],
    ['ckt1qyq6h2at4w46h2at4w46h2at4w46h2at4w4syjmrck', RECIPIENT_LOCK_MESSAGE], // multisig short format
    [
      ccc.Address.fromScript({ ...SECP, args: `0x${'ab'.repeat(20)}` }, new ccc.ClientPublicMainnet()).toString(),
      'Address must be a CKB testnet address starting with ckt1',
    ],
    ['ckt1notanaddress', 'Invalid CKB testnet address'],
    ['', 'Invalid request body'],
    [42, 'Invalid request body'],
  ];
  const before = claimCount();
  for (const [recipient, message] of cases) {
    const res = await claim(recipient, '192.0.2.12');
    assert.equal(res.status, 400, String(recipient));
    assert.deepEqual(res.body, { ok: false, message });
  }
  assert.equal(claimCount(), before);
});

test('a standard (20-byte) and a JoyID (22-byte) address are accepted', async () => {
  const standard = await claim(newAddress(), '192.0.2.20');
  assert.equal(standard.status, 202, JSON.stringify(standard.body));
  assert.equal(standard.body.status, 'queued');
  const joyId = await claim(address(JOYID, `0x0001${'cd'.repeat(20)}`), '192.0.2.21');
  assert.equal(joyId.status, 202, JSON.stringify(joyId.body));
});

// ---------------------------------------------------------------------------------------------------------------------
// F2: one recipient lock and one IPv6 /64 are limited once

test('a claim is stored under the canonical full-format address, so another format of the lock is refused', async () => {
  const fullFormat = address(SECP, `0x${'ab'.repeat(20)}`);
  const shortFormat = 'ckt1qyq2h2at4w46h2at4w46h2at4w46h2at4w4ss72hhz'; // the same lock, legacy short format
  const first = await claim(shortFormat.toUpperCase(), '192.0.2.30');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.address, fullFormat);

  const second = await claim(fullFormat, '192.0.2.31');
  assert.equal(second.status, 429);
  assert.deepEqual(second.body, { ok: false, message: 'This address already has a pending claim' });
});

test('IPv6 clients in one /64 share one rate limit; another /64 has its own', async () => {
  const first = await claim(newAddress(), '2001:db8:100:200::1');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const stored = db.prepare('SELECT ip_hash FROM claims WHERE id = ?').get(first.body.id) as { ip_hash: string };
  assert.equal(stored.ip_hash, hashIp('2001:db8:100:200::/64'));

  for (const ip of ['2001:db8:100:200::2', '2001:db8:100:200:ffff:ffff:ffff:fffe', '2001:0db8:0100:0200:0:0:0:abcd']) {
    const res = await claim(newAddress(), ip);
    assert.equal(res.status, 429, ip);
    assert.deepEqual(res.body, { ok: false, message: 'This network can claim again in 30 min' }, ip);
  }

  const otherNetwork = await claim(newAddress(), '2001:db8:100:201::1');
  assert.equal(otherNetwork.status, 202, JSON.stringify(otherNetwork.body));
});

test('an IPv4 client seen as IPv4-mapped IPv6 and as plain IPv4 shares one rate limit', async () => {
  const first = await claim(newAddress(), '::ffff:198.51.100.40');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const stored = db.prepare('SELECT ip_hash FROM claims WHERE id = ?').get(first.body.id) as { ip_hash: string };
  assert.equal(stored.ip_hash, hashIp(clientNetwork('198.51.100.40')));

  const second = await claim(newAddress(), '198.51.100.40');
  assert.equal(second.status, 429);
  assert.match(second.body.message ?? '', /^This network can claim again in /);

  const otherIpv4 = await claim(newAddress(), '198.51.100.41');
  assert.equal(otherIpv4.status, 202);
});

// ---------------------------------------------------------------------------------------------------------------------
// F3 and F4 through the routes

test('GET /api/balance reuses one lookup for repeated requests', async () => {
  rpcFetches = 0;
  const answers = await Promise.all([1, 2, 3].map(() => fetch(`${BASE}/api/balance`).then((res) => res.json())));
  const later = await (await fetch(`${BASE}/api/balance`)).json();
  assert.equal(rpcFetches, 1);
  for (const answer of [...answers, later]) {
    assert.equal(answer.configured, true);
    assert.equal(answer.cwbtcRaw, '0');
    assert.equal(answer.cwbtc_display, '0 cWBTC');
  }
});

test('GET /api/admin/summary needs exactly "Bearer <ADMIN_TOKEN>"', async () => {
  const get = (authorization?: string) =>
    fetch(`${BASE}/api/admin/summary`, { headers: authorization === undefined ? {} : { authorization } });

  const ok = await get(`Bearer ${ADMIN_TOKEN}`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json()).byStatus));

  for (const authorization of [undefined, '', ADMIN_TOKEN, `bearer ${ADMIN_TOKEN}`, `Bearer ${ADMIN_TOKEN}x`, 'Bearer x']) {
    const res = await get(authorization);
    assert.equal(res.status, 401, String(authorization));
    assert.deepEqual(await res.json(), { ok: false, message: 'Unauthorized' });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// F5: after a restore, "Please claim again" works at once (this test fails every queued claim, so it runs last)

test('a claim failed by failPendingClaims lets the same user claim again at once; a worker-failed one does not', async () => {
  const restored = newAddress();
  const first = await claim(restored, '2001:db8:500:1::1');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  failPendingClaims();
  const status = await (await fetch(`${BASE}/api/claims/${first.body.id}`)).json();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /Please claim again\.$/);

  const again = await claim(restored, '2001:db8:500:1::2');
  assert.equal(again.status, 202, JSON.stringify(again.body));

  const rejected = newAddress();
  const third = await claim(rejected, '2001:db8:500:2::1');
  assert.equal(third.status, 202, JSON.stringify(third.body));
  markClaimStatus(String(third.body.id), 'failed', null, 'CKB transaction rejected: test');
  const retry = await claim(rejected, '2001:db8:500:2::1');
  assert.equal(retry.status, 429);
  assert.match(retry.body.message ?? '', /^This address can claim again in /);
});

test('the claim routes made no CKB RPC request', () => {
  assert.equal(cccRequests.mock.callCount(), 0);
});
