import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { ccc } from '@ckb-ccc/core';

// Test environment, set before src/config.ts loads: no .env file, an unreachable RPC URL, a throwaway hot-wallet key
// (never funded, never used on a chain) and a 30-second balance cache.
const RPC_URL = 'http://127.0.0.1:9/';
const FAUCET_KEY = `0x${randomBytes(32).toString('hex')}`;
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), 'cwbtc-faucet-test-no-such.env');
process.env.DATABASE_PATH = ':memory:';
process.env.CKB_RPC_URL = RPC_URL;
process.env.FAUCET_PRIVATE_KEY = FAUCET_KEY;
delete process.env.FAUCET_PRIVATE_KEY_FILE;
process.env.BALANCE_CACHE_SECONDS = '30';
process.env.CLAIM_AMOUNT_RAW = '1000000';
delete process.env.UDT_CELL_CAPACITY_CKB;

// A clock the tests move. Enabled before faucet.ts loads, so its cachedLoader reads this Date.now.
mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });

// No CKB RPC through ccc: every JSON-RPC request of a ccc client fails here instead of reaching any network.
const cccRequests = mock.method(ccc.RequestorJsonRpc.prototype, 'request', async (method: string) => {
  throw new Error(`test: no CKB RPC (${method})`);
});

// src/ckb/rpc.ts calls the global fetch: answer get_cells with the cells below, or with `nextFailure` once.
const CKB = 100_000_000n;
const CWBTC_TYPE = {
  code_hash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hash_type: 'type',
  args: '0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000',
};
const OTHER_UDT_TYPE = { ...CWBTC_TYPE, args: `0x${'77'.repeat(32)}00000000` };
const udtData = (amount: bigint) => `0x${Buffer.from(ccc.numLeToBytes(amount, 16)).toString('hex')}`;
const hex = (value: bigint) => `0x${value.toString(16)}`;
let faucetLockRpc: { code_hash: string; hash_type: string; args: string } | undefined;
const cell = (index: number, capacity: bigint, type: typeof CWBTC_TYPE | null, data: string) => ({
  out_point: { tx_hash: `0x${'aa'.repeat(32)}`, index: hex(BigInt(index)) },
  output: { capacity: hex(capacity), lock: faucetLockRpc, type },
  output_data: data,
  block_number: '0x1',
});
const fetchCalls: Array<{ url: string; method: string; params: unknown[] }> = [];
let nextFailure: Response | undefined;
mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  fetchCalls.push({ url: String(input), method: body.method, params: body.params });
  if (nextFailure) {
    const failure = nextFailure;
    nextFailure = undefined;
    return failure;
  }
  assert.equal(body.method, 'get_cells');
  const objects = [
    cell(0, 147n * CKB, CWBTC_TYPE, udtData(5_000_000n)),
    cell(1, 148n * CKB, CWBTC_TYPE, udtData(3_000_000n)),
    cell(2, 200n * CKB, OTHER_UDT_TYPE, udtData(999n)),
    cell(3, 10_000n * CKB, null, '0x'),
  ];
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects, last_cursor: '0x00' } }));
});

const { getCachedFaucetBalances, getFaucetAddress, getFaucetBalances, getFaucetLockScript, transferCwbtc } = await import(
  './faucet.js'
);
const { RECIPIENT_LOCK_MESSAGE } = await import('./recipient.js');
const { estimateClaimsByCapacity } = await import('./capacity.js');

const faucetLock = await getFaucetLockScript();
faucetLockRpc = { code_hash: faucetLock.codeHash, hash_type: faucetLock.hashType, args: faucetLock.args };
const FAUCET_ADDRESS = await getFaucetAddress();
const TOTAL = (147n + 148n + 200n + 10_000n) * CKB;
const EXPECTED_BALANCES = {
  configured: true,
  address: FAUCET_ADDRESS,
  cwbtcRaw: '8000000',
  totalCapacityShannons: TOTAL.toString(),
  plainCapacityShannons: (10_000n * CKB).toString(),
  estimatedClaimsByCwbtc: 8,
  estimatedClaimsByCapacity: estimateClaimsByCapacity(TOTAL, 147n * CKB),
};

/** Moves the clock past the 30-second cache, so a test starts without a cached answer. */
const expireCache = () => mock.timers.tick(31_000);

// ---------------------------------------------------------------------------------------------------------------------
// F3: /api/balance's lookup is cached

test('getFaucetBalances reads the hot wallet with one get_cells on the configured RPC, every call', async () => {
  fetchCalls.length = 0;
  assert.deepEqual(await getFaucetBalances(), EXPECTED_BALANCES);
  assert.deepEqual(await getFaucetBalances(), EXPECTED_BALANCES);
  assert.equal(fetchCalls.length, 2);
  for (const call of fetchCalls) {
    assert.equal(call.url, RPC_URL);
    const [searchKey] = call.params as [{ script: unknown; script_type: string; script_search_mode: string }];
    assert.deepEqual(searchKey.script, faucetLockRpc);
    assert.equal(searchKey.script_type, 'lock');
    assert.equal(searchKey.script_search_mode, 'exact');
  }
});

test('getCachedFaucetBalances reuses its answer for BALANCE_CACHE_SECONDS, then looks up again', async () => {
  expireCache();
  fetchCalls.length = 0;
  const first = await getCachedFaucetBalances();
  assert.deepEqual(first, EXPECTED_BALANCES);
  assert.equal(fetchCalls.length, 1);

  mock.timers.tick(29_999);
  assert.equal(await getCachedFaucetBalances(), first, 'the same answer within 30 s');
  assert.equal(fetchCalls.length, 1);

  mock.timers.tick(1);
  const second = await getCachedFaucetBalances();
  assert.equal(fetchCalls.length, 2, 'a new lookup after 30 s');
  assert.notEqual(second, first);
  assert.deepEqual(second, EXPECTED_BALANCES);
});

test('concurrent getCachedFaucetBalances calls share one lookup', async () => {
  expireCache();
  fetchCalls.length = 0;
  const answers = await Promise.all(Array.from({ length: 5 }, () => getCachedFaucetBalances()));
  assert.equal(fetchCalls.length, 1);
  for (const answer of answers) assert.equal(answer, answers[0]);
});

test('a failed balance lookup is not cached: the next call looks up again', async () => {
  expireCache();
  fetchCalls.length = 0;
  nextFailure = new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' });
  await assert.rejects(getCachedFaucetBalances(), /CKB RPC HTTP 502: Bad Gateway/);
  assert.deepEqual(await getCachedFaucetBalances(), EXPECTED_BALANCES);
  assert.equal(fetchCalls.length, 2);
  assert.equal(await getCachedFaucetBalances(), await getCachedFaucetBalances());
  assert.equal(fetchCalls.length, 2);
});

test('the balance lookups go through src/ckb/rpc.ts only, never through a ccc client', () => {
  assert.equal(cccRequests.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// F1: transferCwbtc checks the recipient before it builds a transaction or touches the chain

const testnet = new ccc.ClientPublicTestnet({ url: RPC_URL });
const SECP = { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type' } as const;
const JOYID = { codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac', hashType: 'type' } as const;
const address = (lock: { codeHash: string; hashType: 'type' }, args: string) =>
  ccc.Address.fromScript({ ...lock, args }, testnet).toString();

test('transferCwbtc refuses a long-args, short-args or unknown-lock recipient before any RPC request', async () => {
  const refused: Array<[string, RegExp | string]> = [
    [address(SECP, `0x${'ab'.repeat(580)}`), /^This standard CKB address has 580 bytes of lock args; .* with 20\./],
    [address(SECP, `0x${'ab'.repeat(21)}`), /^This standard CKB address has 21 bytes of lock args/],
    [address(SECP, `0x${'ab'.repeat(19)}`), /^This standard CKB address has 19 bytes of lock args/],
    [address(JOYID, `0x0001${'cd'.repeat(21)}`), /^This JoyID address has 23 bytes of lock args; .* with 22\./],
    [address(JOYID, `0x0001${'cd'.repeat(18)}`), /^This JoyID address has 20 bytes of lock args/],
    [address({ codeHash: `0x${'11'.repeat(32)}`, hashType: 'type' }, `0x${'ab'.repeat(20)}`), RECIPIENT_LOCK_MESSAGE],
    ['ckt1qyq6h2at4w46h2at4w46h2at4w46h2at4w4syjmrck', RECIPIENT_LOCK_MESSAGE], // secp256k1 multisig, short format
  ];
  fetchCalls.length = 0;
  cccRequests.mock.resetCalls();
  for (const [recipient, error] of refused) {
    await assert.rejects(
      transferCwbtc(recipient, 1_000_000n),
      (err: Error) => (typeof error === 'string' ? err.message === error : error.test(err.message)),
      recipient.slice(0, 60),
    );
  }
  assert.equal(cccRequests.mock.callCount(), 0, 'no CKB RPC request through ccc');
  assert.equal(fetchCalls.length, 0, 'no fetch');
});

test('transferCwbtc refuses an address of another network or a malformed one before any RPC request', async () => {
  cccRequests.mock.resetCalls();
  const mainnetAddress = ccc.Address.fromScript({ ...SECP, args: `0x${'ab'.repeat(20)}` }, new ccc.ClientPublicMainnet());
  await assert.rejects(transferCwbtc(mainnetAddress.toString(), 1_000_000n), /Unknown address prefix ckb/);
  await assert.rejects(transferCwbtc('ckt1notanaddress', 1_000_000n), /Unknown address format/);
  assert.equal(cccRequests.mock.callCount(), 0);
});

test('transferCwbtc lets a standard (20-byte) and a JoyID (22-byte) recipient past its checks, to the chain lookups', async () => {
  for (const recipient of [address(SECP, `0x${'ab'.repeat(20)}`), address(JOYID, `0x0001${'cd'.repeat(20)}`)]) {
    cccRequests.mock.resetCalls();
    // The first RPC request comes after both checks; here it fails, so no transaction is ever built in full or sent.
    await assert.rejects(transferCwbtc(recipient, 1_000_000n), /^Error: test: no CKB RPC/);
    assert.ok(cccRequests.mock.callCount() >= 1);
    const methods = cccRequests.mock.calls.map((call) => call.arguments[0]);
    assert.ok(!methods.includes('send_transaction'), methods.join(', '));
  }
});
