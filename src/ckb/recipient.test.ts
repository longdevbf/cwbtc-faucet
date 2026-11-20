import assert from 'node:assert/strict';
import test from 'node:test';
import { ccc } from '@ckb-ccc/ccc';
import {
  RECIPIENT_LOCK_MESSAGE,
  RECIPIENT_LOCKS,
  isAllowedRecipientLock,
  recipientLockError,
  recipientLocks,
  recipientLockTypes,
} from './recipient.js';
import { joyIdCellCapacity, minimumCapacity, udtCellCapacity } from './capacity.js';

const SECP = { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type' } as const;
const JOYID = { codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac', hashType: 'type' } as const;
const CWBTC_TYPE = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type',
  args: '0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000',
} as const;
const AMOUNT = ccc.numLeToBytes(1_000_000n, 16);
const CKB = 100_000_000n;

test('the testnet recipient locks are the standard secp256k1 lock and JoyID', async () => {
  const types = await recipientLockTypes(new ccc.ClientPublicTestnet());
  assert.deepEqual(types, [SECP, JOYID]);
});

test('accepts a standard or a JoyID address with any args, refuses every other lock', () => {
  const allowed = [SECP, JOYID];
  assert.equal(isAllowedRecipientLock({ ...SECP }, allowed), true);
  assert.equal(isAllowedRecipientLock({ ...JOYID }, allowed), true);
  assert.equal(isAllowedRecipientLock({ ...JOYID, hashType: 'data1' }, allowed), false);
  assert.equal(isAllowedRecipientLock({ codeHash: '0x' + '11'.repeat(32), hashType: 'type' }, allowed), false);
});

test('a JoyID cWBTC cell gets 148 CKB, a standard one keeps the configured 147', () => {
  const joyIdLock = { ...JOYID, args: '0x0001' + 'ab'.repeat(20) };
  const secpLock = { ...SECP, args: '0x' + 'ab'.repeat(20) };
  assert.equal(minimumCapacity({ lock: joyIdLock, type: CWBTC_TYPE }, AMOUNT), 148n * CKB);
  assert.equal(udtCellCapacity(147n * CKB, { lock: joyIdLock, type: CWBTC_TYPE }, AMOUNT), 148n * CKB);
  assert.equal(udtCellCapacity(147n * CKB, { lock: secpLock, type: CWBTC_TYPE }, AMOUNT), 147n * CKB);
});

test('the page shows the JoyID capacity only when it is above the configured one', () => {
  assert.equal(joyIdCellCapacity(147n * CKB), 148n * CKB);
  assert.equal(joyIdCellCapacity(200n * CKB), 200n * CKB);
});

// F1: exact lock args lengths (20 bytes standard, 22 bytes JoyID).

const JOYID_MAINNET = {
  codeHash: '0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323',
  hashType: 'type',
} as const;
const testnet = new ccc.ClientPublicTestnet();
const mainnet = new ccc.ClientPublicMainnet();
const secpArgs = (bytes: number): string => '0x' + 'ab'.repeat(bytes);
// A JoyID args value of `bytes` bytes: the 2-byte mode 0x0001 and then a hash (shorter than the mode: just bytes).
const joyIdArgs = (bytes: number): string => (bytes < 2 ? '0x' + 'cd'.repeat(bytes) : '0x0001' + 'cd'.repeat(bytes - 2));
const addressOf = (lock: { codeHash: string; hashType: ccc.HashTypeLike }, args: string, client: ccc.Client): string =>
  ccc.Address.fromScript({ ...lock, args }, client).toString();
const scriptOf = async (address: string, client: ccc.Client) => {
  const { script } = await ccc.Address.fromString(address, client);
  return { codeHash: script.codeHash, hashType: script.hashType as 'type', args: script.args };
};

test('RECIPIENT_LOCKS names the standard lock with 20-byte args and JoyID with 22-byte args', () => {
  assert.deepEqual(
    RECIPIENT_LOCKS.map(({ known, name, argsBytes }) => ({ known, name, argsBytes })),
    [
      { known: ccc.KnownScript.Secp256k1Blake160, name: 'standard CKB', argsBytes: 20 },
      { known: ccc.KnownScript.JoyId, name: 'JoyID', argsBytes: 22 },
    ],
  );
});

test('recipientLocks gives each network its own lock code hashes with the exact args lengths', async () => {
  assert.deepEqual(await recipientLocks(testnet), [
    { ...SECP, name: 'standard CKB', argsBytes: 20 },
    { ...JOYID, name: 'JoyID', argsBytes: 22 },
  ]);
  assert.deepEqual(await recipientLocks(mainnet), [
    { ...SECP, name: 'standard CKB', argsBytes: 20 },
    { ...JOYID_MAINNET, name: 'JoyID', argsBytes: 22 },
  ]);
});

test('recipientLockError accepts a standard lock with exactly 20 bytes of args, refuses any other length', async () => {
  const locks = await recipientLocks(testnet);
  assert.equal(recipientLockError({ ...SECP, args: secpArgs(20) }, locks), null);
  for (const bytes of [0, 1, 19, 21, 22, 32, 580]) {
    const error = recipientLockError({ ...SECP, args: secpArgs(bytes) }, locks);
    assert.equal(
      error,
      `This standard CKB address has ${bytes} bytes of lock args; the faucet only sends to standard CKB addresses ` +
        'with 20. Copy the address from your wallet again.',
      `${bytes} bytes`,
    );
  }
});

test('recipientLockError accepts a JoyID lock with exactly 22 bytes of args, refuses any other length', async () => {
  const locks = await recipientLocks(testnet);
  assert.equal(recipientLockError({ ...JOYID, args: joyIdArgs(22) }, locks), null);
  for (const bytes of [0, 1, 2, 20, 21, 23, 24, 580]) {
    const error = recipientLockError({ ...JOYID, args: joyIdArgs(bytes) }, locks);
    assert.match(error ?? '', new RegExp(`^This JoyID address has ${bytes} bytes of lock args; .* JoyID addresses with 22\\.`));
  }
});

test('recipientLockError refuses an unknown lock, or a known code hash with another hash type, whatever its args', async () => {
  const locks = await recipientLocks(testnet);
  const unknown = { codeHash: '0x' + '11'.repeat(32), hashType: 'type' as const };
  assert.equal(recipientLockError({ ...unknown, args: secpArgs(20) }, locks), RECIPIENT_LOCK_MESSAGE);
  assert.equal(recipientLockError({ ...unknown, args: joyIdArgs(22) }, locks), RECIPIENT_LOCK_MESSAGE);
  assert.equal(recipientLockError({ ...SECP, hashType: 'data1', args: secpArgs(20) }, locks), RECIPIENT_LOCK_MESSAGE);
  assert.equal(recipientLockError({ ...SECP, hashType: 'data', args: secpArgs(20) }, locks), RECIPIENT_LOCK_MESSAGE);
  assert.equal(recipientLockError({ ...JOYID, hashType: 'data1', args: joyIdArgs(22) }, locks), RECIPIENT_LOCK_MESSAGE);
  assert.equal(recipientLockError({ ...SECP, args: secpArgs(20) }, []), RECIPIENT_LOCK_MESSAGE);
});

test('testnet addresses: standard (20) and JoyID (22) pass, long-args and other locks are refused', async () => {
  const locks = await recipientLocks(testnet);
  const check = async (address: string) => recipientLockError(await scriptOf(address, testnet), locks);
  assert.equal(await check(addressOf(SECP, secpArgs(20), testnet)), null);
  assert.equal(await check(addressOf(JOYID, joyIdArgs(22), testnet)), null);
  // Legacy short format (code index 0 = secp256k1-blake160) and legacy full-type format decode to the same locks.
  assert.equal(await check('ckt1qyq2h2at4w46h2at4w46h2at4w46h2at4w4ss72hhz'), null);
  assert.equal(
    await check('ckt1qnfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqqpehxumnwdehxumnwdehxumnwdehxumnwdc9wq45'),
    null,
  );

  assert.match((await check(addressOf(SECP, secpArgs(580), testnet))) ?? '', /has 580 bytes of lock args/);
  assert.match((await check(addressOf(SECP, secpArgs(21), testnet))) ?? '', /has 21 bytes of lock args/);
  assert.match((await check(addressOf(JOYID, joyIdArgs(400), testnet))) ?? '', /JoyID address has 400 bytes/);
  assert.match((await check(addressOf(JOYID, joyIdArgs(20), testnet))) ?? '', /JoyID address has 20 bytes/);
  // Legacy short format with code index 1 (secp256k1 multisig), and legacy full-data format (hash type "data").
  assert.equal(await check('ckt1qyq6h2at4w46h2at4w46h2at4w46h2at4w4syjmrck'), RECIPIENT_LOCK_MESSAGE);
  assert.equal(
    await check('ckt1q2da0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xw32at4w46h2at4w46h2at4w46h2at4w46kvdzdmj'),
    RECIPIENT_LOCK_MESSAGE,
  );
});

test('mainnet addresses: the same rules hold with the mainnet JoyID code hash', async () => {
  const locks = await recipientLocks(mainnet);
  const check = async (address: string) => recipientLockError(await scriptOf(address, mainnet), locks);
  const standard = addressOf(SECP, secpArgs(20), mainnet);
  assert.match(standard, /^ckb1/);
  assert.equal(await check(standard), null);
  assert.equal(await check('ckb1qyq2h2at4w46h2at4w46h2at4w46h2at4w4sdm5gm7'), null);
  assert.equal(await check(addressOf(JOYID_MAINNET, joyIdArgs(22), mainnet)), null);
  assert.match((await check(addressOf(SECP, secpArgs(580), mainnet))) ?? '', /has 580 bytes of lock args/);
  assert.match((await check(addressOf(JOYID_MAINNET, joyIdArgs(23), mainnet))) ?? '', /JoyID address has 23 bytes/);
  // A testnet JoyID lock is not a mainnet JoyID lock.
  assert.equal(recipientLockError({ ...JOYID, args: joyIdArgs(22) }, locks), RECIPIENT_LOCK_MESSAGE);
});

test('an address of one network does not parse with the other network client', async () => {
  await assert.rejects(ccc.Address.fromString(addressOf(SECP, secpArgs(20), mainnet), testnet), /Unknown address prefix ckb/);
  await assert.rejects(ccc.Address.fromString(addressOf(SECP, secpArgs(20), testnet), mainnet), /Unknown address prefix ckt/);
});
