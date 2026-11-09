import assert from 'node:assert/strict';
import test from 'node:test';
import { ccc } from '@ckb-ccc/ccc';
import { isAllowedRecipientLock, recipientLockTypes } from './recipient.js';
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
