import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { ccc } from '@ckb-ccc/core';

// Test environment, set before src/config.ts loads: no .env file, an in-memory claims database, an unreachable RPC.
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), 'cwbtc-faucet-test-no-such.env');
process.env.DATABASE_PATH = ':memory:';
process.env.CKB_RPC_URL = 'http://127.0.0.1:9/';
process.env.IP_HASH_SALT = 'security-test-salt';

// Spy on crypto.timingSafeEqual; syncBuiltinESMExports makes security.ts's named import see the spy.
const timingSafeEqual = mock.method(crypto, 'timingSafeEqual');
syncBuiltinESMExports();

// No CKB RPC in these tests: every JSON-RPC request of a ccc client fails here instead of reaching any network.
const rpcRequests = mock.method(ccc.RequestorJsonRpc.prototype, 'request', async (method: string) => {
  throw new Error(`test: no CKB RPC (${method})`);
});

const { checkClaimEligibility, clientNetwork, hasBearerToken, hashIp, normalizeAddress, resolveRecipient } = await import(
  './security.js'
);
const { insertClaim, markClaimStatus } = await import('./db.js');
const { RECIPIENT_LOCK_MESSAGE } = await import('./ckb/recipient.js');

const testnet = new ccc.ClientPublicTestnet({ url: 'http://127.0.0.1:9/' });
const SECP = { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type' } as const;
const JOYID = { codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac', hashType: 'type' } as const;
const fullAddress = (lock: typeof SECP | typeof JOYID, args: string): string =>
  ccc.Address.fromScript({ ...lock, args }, testnet).toString();

// One standard lock (args 0xab x 20) written three ways, and one JoyID lock (args 0x0001 + 0xcd x 20) written two ways.
const SECP_ARGS = '0x' + 'ab'.repeat(20);
const SECP_FULL = fullAddress(SECP, SECP_ARGS);
const SECP_SHORT = 'ckt1qyq2h2at4w46h2at4w46h2at4w46h2at4w4ss72hhz'; // legacy short format, code index 0
const SECP_FULL_TYPE = 'ckt1qjda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xw32at4w46h2at4w46h2at4w46h2at4w46knh78d9';
const JOYID_ARGS = '0x0001' + 'cd'.repeat(20);
const JOYID_FULL = fullAddress(JOYID, JOYID_ARGS);
const JOYID_FULL_TYPE =
  'ckt1qnfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqqpehxumnwdehxumnwdehxumnwdehxumnwdc9wq45';

// ---------------------------------------------------------------------------------------------------------------------
// F2: clientNetwork

test('clientNetwork keeps an IPv4 address as it is', () => {
  assert.equal(clientNetwork('203.0.113.7'), '203.0.113.7');
  assert.equal(clientNetwork('10.0.0.1'), '10.0.0.1');
  assert.notEqual(clientNetwork('203.0.113.7'), clientNetwork('203.0.113.8'));
  assert.equal(clientNetwork('unknown'), 'unknown');
});

test('clientNetwork turns an IPv4-mapped IPv6 address (::ffff:a.b.c.d) into its IPv4 address', () => {
  assert.equal(clientNetwork('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientNetwork('::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(clientNetwork('::ffff:127.0.0.1'), '127.0.0.1');
});

// A proxy may write the IPv4-mapped address in full or in hex instead of "::ffff:a.b.c.d"; it is still that IPv4 client.
test('clientNetwork turns every spelling of an IPv4-mapped IPv6 address into its IPv4 address', () => {
  assert.equal(clientNetwork('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientNetwork('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(clientNetwork('0000:0000:0000:0000:0000:ffff:cb00:7107'), '203.0.113.7');
  assert.equal(clientNetwork('::FFFF:CB00:7107'), '203.0.113.7');
  assert.equal(clientNetwork('::ffff:0:1'), '0.0.0.1');
  assert.equal(clientNetwork('::ffff:ffff:ffff'), '255.255.255.255');
});

test('clientNetwork does not take an address that only resembles an IPv4-mapped one for IPv4', () => {
  assert.equal(clientNetwork('::fffe:cb00:7107'), '0:0:0:0::/64');
  assert.equal(clientNetwork('1::ffff:cb00:7107'), '1:0:0:0::/64');
  assert.equal(clientNetwork('::ffff:0:203.0.113.7'), '0:0:0:0::/64'); // IPv4-translated (::ffff:0:0/96), not mapped
  assert.equal(clientNetwork('64:ff9b::203.0.113.7'), '64:ff9b:0:0::/64'); // NAT64
});

test('clientNetwork turns an IPv6 address into its /64 network, however the address is written', () => {
  const network = '2001:db8:1:2::/64';
  for (const ip of [
    '2001:db8:1:2:3:4:5:6',
    '2001:db8:1:2::1',
    '2001:db8:1:2::',
    '2001:0DB8:0001:0002:FFFF:FFFF:FFFF:FFFF',
    '2001:db8:1:2:aaaa::bbbb',
    '2001:db8:1:2:0:0:192.0.2.1',
  ]) {
    assert.equal(clientNetwork(ip), network, ip);
  }
  assert.equal(clientNetwork('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientNetwork('2001:db8::1:0:0:1'), '2001:db8:0:0::/64');
  assert.equal(clientNetwork('2001:db8:1::'), '2001:db8:1:0::/64');
  assert.equal(clientNetwork('::1'), '0:0:0:0::/64');
  assert.equal(clientNetwork('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
});

test('clientNetwork drops an IPv6 zone index', () => {
  assert.equal(clientNetwork('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientNetwork('fe80::1%eth0'), clientNetwork('fe80::abcd%en1'));
});

test('two IPv6 addresses in one /64 give one rate-limit key; different /64s give different keys', () => {
  const key = (ip: string) => hashIp(clientNetwork(ip));
  assert.equal(key('2001:db8:aa:bb::1'), key('2001:db8:aa:bb:ffff:eeee:dddd:cccc'));
  assert.equal(key('2001:db8:aa:bb::1'), key('2001:0db8:00aa:00bb:0000:0000:0000:0002'));
  assert.notEqual(key('2001:db8:aa:bb::1'), key('2001:db8:aa:bc::1'));
  assert.notEqual(key('2001:db8:aa:bb::1'), key('2001:db9:aa:bb::1'));
  assert.equal(key('::ffff:198.51.100.4'), key('198.51.100.4'));
  assert.notEqual(key('198.51.100.4'), key('198.51.100.5'));
});

// ---------------------------------------------------------------------------------------------------------------------
// F4: hasBearerToken

const TOKEN = 'k3y-0123456789abcdef';

test('hasBearerToken accepts exactly "Bearer <token>"', () => {
  assert.equal(hasBearerToken(`Bearer ${TOKEN}`, TOKEN), true);
});

test('hasBearerToken refuses a wrong token, a different length, or a missing or different scheme', () => {
  const wrongSameLength = `Bearer ${'x'.repeat(TOKEN.length)}`;
  for (const header of [
    wrongSameLength,
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN} `,
    ` Bearer ${TOKEN}`,
    `Bearer  ${TOKEN}`,
    `bearer ${TOKEN}`,
    `BEARER ${TOKEN}`,
    `Basic ${TOKEN}`,
    TOKEN,
    'Bearer',
    'Bearer ',
    '',
  ]) {
    assert.equal(hasBearerToken(header, TOKEN), false, JSON.stringify(header));
  }
  assert.equal(hasBearerToken(undefined, TOKEN), false);
});

test('hasBearerToken refuses everything when no token is configured', () => {
  for (const header of ['Bearer ', 'Bearer', '', undefined, 'Bearer undefined', 'Bearer null']) {
    assert.equal(hasBearerToken(header, ''), false, JSON.stringify(header));
  }
});

test('hasBearerToken handles a header with the same character count but other bytes', () => {
  // "Bearer é" has 8 characters but 9 bytes; "Bearer a" has 8 of each.
  assert.equal(hasBearerToken('Bearer é', 'a'), false);
  assert.equal(hasBearerToken('Bearer é', 'ab'), false);
  assert.equal(hasBearerToken('Bearer ü', 'ü'), true);
});

const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

test('hasBearerToken compares the sha256 digests with crypto.timingSafeEqual, whatever the header length', () => {
  const cases: Array<[string, boolean]> = [
    [`Bearer ${TOKEN}`, true],
    [`Bearer ${'x'.repeat(TOKEN.length)}`, false], // same length
    [`Bearer ${TOKEN}x`, false], // one byte longer
    [`Bearer ${TOKEN.slice(0, -1)}`, false], // one byte shorter
    ['Bearer x', false], // much shorter
    [`Bearer ${TOKEN.repeat(100)}`, false], // much longer
  ];
  for (const [header, expected] of cases) {
    timingSafeEqual.mock.resetCalls();
    assert.equal(hasBearerToken(header, TOKEN), expected, header);
    assert.equal(timingSafeEqual.mock.callCount(), 1, `one timingSafeEqual call for ${JSON.stringify(header)}`);

    const args = timingSafeEqual.mock.calls[0].arguments as unknown as [Uint8Array, Uint8Array];
    for (const arg of args) assert.equal(arg.length, 32, 'a 32-byte digest, not the raw string');
    assert.deepEqual(
      args.map((arg) => Buffer.from(arg).toString('hex')).sort(),
      [sha256Hex(header), sha256Hex(`Bearer ${TOKEN}`)].sort(),
    );
    for (const arg of args) assert.ok(!Buffer.from(arg).toString('latin1').includes(TOKEN), 'the token is not compared raw');
  }
});

test('hasBearerToken returns what timingSafeEqual decides, with no other comparison', () => {
  // "Equal" for a wrong token of another length: accepted, so nothing else (such as a length check) refuses it.
  timingSafeEqual.mock.mockImplementationOnce(() => true);
  assert.equal(hasBearerToken('Bearer x', TOKEN), true);
  // "Not equal" for the right token: refused.
  timingSafeEqual.mock.mockImplementationOnce(() => false);
  assert.equal(hasBearerToken(`Bearer ${TOKEN}`, TOKEN), false);
  // Back to the real comparison.
  assert.equal(hasBearerToken(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(hasBearerToken('Bearer x', TOKEN), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// F1 + F2: resolveRecipient

test('the test vectors are one standard lock and one JoyID lock', async () => {
  for (const address of [SECP_FULL, SECP_SHORT, SECP_FULL_TYPE]) {
    const { script } = await ccc.Address.fromString(address, testnet);
    assert.deepEqual({ codeHash: script.codeHash, hashType: script.hashType, args: script.args }, { ...SECP, args: SECP_ARGS });
  }
  for (const address of [JOYID_FULL, JOYID_FULL_TYPE]) {
    const { script } = await ccc.Address.fromString(address, testnet);
    assert.deepEqual({ codeHash: script.codeHash, hashType: script.hashType, args: script.args }, { ...JOYID, args: JOYID_ARGS });
  }
  assert.notEqual(SECP_SHORT, SECP_FULL);
  assert.notEqual(JOYID_FULL_TYPE, JOYID_FULL);
});

test('resolveRecipient gives one canonical full-format address for every format of one standard lock', async () => {
  for (const address of [SECP_FULL, SECP_SHORT, SECP_FULL_TYPE, normalizeAddress(SECP_SHORT.toUpperCase())]) {
    assert.deepEqual(await resolveRecipient(address), { ok: true, address: SECP_FULL }, address);
  }
  assert.match(SECP_FULL, /^ckt1q[0-9a-z]+$/);
});

test('resolveRecipient gives one canonical full-format address for every format of one JoyID lock', async () => {
  for (const address of [JOYID_FULL, JOYID_FULL_TYPE, normalizeAddress(`  ${JOYID_FULL.toUpperCase()} `)]) {
    assert.deepEqual(await resolveRecipient(address), { ok: true, address: JOYID_FULL }, address);
  }
});

test('resolveRecipient refuses a long-args address with a plain message', async () => {
  const longSecp = await resolveRecipient(fullAddress(SECP, '0x' + 'ab'.repeat(580)));
  assert.deepEqual(longSecp, {
    ok: false,
    error:
      'This standard CKB address has 580 bytes of lock args; the faucet only sends to standard CKB addresses with 20. ' +
      'Copy the address from your wallet again.',
  });
  const shortSecp = await resolveRecipient(fullAddress(SECP, '0x' + 'ab'.repeat(19)));
  assert.equal(shortSecp.ok, false);
  const longJoyId = await resolveRecipient(fullAddress(JOYID, '0x0001' + 'cd'.repeat(21)));
  assert.deepEqual(longJoyId, {
    ok: false,
    error:
      'This JoyID address has 23 bytes of lock args; the faucet only sends to JoyID addresses with 22. ' +
      'Copy the address from your wallet again.',
  });
});

test('resolveRecipient refuses other locks, mainnet addresses and strings that are not addresses', async () => {
  const multisig = 'ckt1qyq6h2at4w46h2at4w46h2at4w46h2at4w4syjmrck'; // legacy short format, code index 1
  assert.deepEqual(await resolveRecipient(multisig), { ok: false, error: RECIPIENT_LOCK_MESSAGE });
  const otherLock = ccc.Address.fromScript({ codeHash: '0x' + '11'.repeat(32), hashType: 'type', args: SECP_ARGS }, testnet);
  assert.deepEqual(await resolveRecipient(otherLock.toString()), { ok: false, error: RECIPIENT_LOCK_MESSAGE });

  const mainnetAddress = ccc.Address.fromScript({ ...SECP, args: SECP_ARGS }, new ccc.ClientPublicMainnet()).toString();
  assert.deepEqual(await resolveRecipient(mainnetAddress), {
    ok: false,
    error: 'Address must be a CKB testnet address starting with ckt1',
  });
  for (const address of ['ckt1', 'ckt1notanaddress', `${SECP_FULL.slice(0, -1)}q`, 'ckt1qyq2h2at4w46h2at4w46']) {
    assert.deepEqual(await resolveRecipient(address), { ok: false, error: 'Invalid CKB testnet address' }, address);
  }
});

test('resolveRecipient needs no CKB RPC', () => {
  assert.equal(rpcRequests.mock.callCount(), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// F2: limits count one recipient lock once, and one IPv6 /64 once

let claimSeq = 0;
function addClaim(address: string, ipHash: string, now = Date.now()): string {
  claimSeq += 1;
  const id = `security-test-${claimSeq}`;
  insertClaim({
    id,
    address,
    ip_hash: ipHash,
    amount_raw: '1000000',
    status: 'queued',
    user_agent: null,
    created_at: now,
    updated_at: now,
    cooldown_until: now + 86_400_000,
  });
  return id;
}

test('a claim under one address format blocks the same lock written in another format', async () => {
  const full = await resolveRecipient(fullAddress(SECP, '0x' + '5a'.repeat(20)));
  assert.equal(full.ok, true);
  const id = addClaim(full.ok ? full.address : '', hashIp(clientNetwork('198.51.100.10')));

  // The legacy short format of the same lock (args 0x5a x 20), from another network.
  const shortAddress = 'ckt1qyq95kj6tfd95kj6tfd95kj6tfd95kj6tfdqptl32z';
  assert.notEqual(shortAddress, full.ok ? full.address : '');
  const short = await resolveRecipient(shortAddress);
  assert.deepEqual(short, full);
  const otherIp = hashIp(clientNetwork('198.51.100.11'));
  assert.equal(checkClaimEligibility(short.ok ? short.address : '', otherIp), 'This address already has a pending claim');

  markClaimStatus(id, 'confirmed', '0x' + '00'.repeat(32));
  assert.match(checkClaimEligibility(short.ok ? short.address : '', otherIp) ?? '', /^This address can claim again in /);

  const other = await resolveRecipient(fullAddress(SECP, '0x' + '5b'.repeat(20)));
  assert.equal(checkClaimEligibility(other.ok ? other.address : '', otherIp), null);
});

test('a claim under the short format blocks the full format too', async () => {
  const args = '0x' + 'ab'.repeat(20);
  const short = await resolveRecipient(SECP_SHORT);
  assert.equal(short.ok, true);
  addClaim(short.ok ? short.address : '', hashIp(clientNetwork('198.51.100.20')));
  const full = await resolveRecipient(fullAddress(SECP, args));
  assert.equal(checkClaimEligibility(full.ok ? full.address : '', hashIp('198.51.100.21')), 'This address already has a pending claim');
});

test('a claim from one IPv6 address puts its whole /64 on the IP cooldown', async () => {
  const first = await resolveRecipient(fullAddress(SECP, '0x' + '61'.repeat(20)));
  const second = await resolveRecipient(fullAddress(SECP, '0x' + '62'.repeat(20)));
  assert.ok(first.ok && second.ok);
  addClaim(first.address, hashIp(clientNetwork('2001:db8:77:1::10')));

  assert.equal(
    checkClaimEligibility(second.address, hashIp(clientNetwork('2001:db8:77:1:9999:8888:7777:6666'))),
    'This network can claim again in 30 min',
  );
  assert.equal(checkClaimEligibility(second.address, hashIp(clientNetwork('2001:db8:77:2::10'))), null);
});
