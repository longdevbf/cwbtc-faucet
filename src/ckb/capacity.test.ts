import assert from 'node:assert/strict';
import test from 'node:test';
import { ccc } from '@ckb-ccc/ccc';
import {
  CWBTC_CELL_OCCUPIED_CKB,
  DEFAULT_UDT_CELL_CAPACITY_CKB,
  SHANNONS_PER_CKB,
  estimateClaimsByCapacity,
  minimumCapacity,
  udtCellCapacity,
} from './capacity.js';

// Standard secp256k1-blake160 lock on CKB testnet, with a 20-byte args placeholder.
const secp256k1Lock: ccc.ScriptLike = {
  codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
  hashType: 'type',
  args: `0x${'11'.repeat(20)}`,
};

// The cWBTC xUDT type script (same as config.cwbtc.typeScript).
const cwbtcType: ccc.ScriptLike = {
  codeHash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb',
  hashType: 'type',
  args: '0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000',
};

const amountData = ccc.numLeToBytes(1_000_000n, 16);
const ckb = (value: bigint): bigint => value * SHANNONS_PER_CKB;

test('a cWBTC cell for a secp256k1 address occupies 146 CKB', () => {
  const minimum = minimumCapacity({ lock: secp256k1Lock, type: cwbtcType }, amountData);
  assert.equal(minimum, ckb(146n));
  assert.equal(minimum, ckb(CWBTC_CELL_OCCUPIED_CKB));
});

test('an xUDT without the flags field would occupy 142 CKB', () => {
  const type = { ...cwbtcType, args: `0x${'22'.repeat(32)}` };
  assert.equal(minimumCapacity({ lock: secp256k1Lock, type }, amountData), ckb(142n));
});

test('the default cell capacity is the minimum plus a 1 CKB margin', () => {
  assert.equal(DEFAULT_UDT_CELL_CAPACITY_CKB, 147n);
  assert.equal(udtCellCapacity(ckb(DEFAULT_UDT_CELL_CAPACITY_CKB), { lock: secp256k1Lock, type: cwbtcType }, amountData), ckb(147n));
});

test('a capacity below the minimum is raised to the minimum', () => {
  const lock = { ...secp256k1Lock, args: `0x${'11'.repeat(24)}` };
  assert.equal(udtCellCapacity(ckb(147n), { lock, type: cwbtcType }, amountData), ckb(150n));
  assert.equal(udtCellCapacity(ckb(100n), { lock: secp256k1Lock, type: cwbtcType }, amountData), ckb(146n));
});

test('the claim estimate keeps a reserve for the faucet change cells', () => {
  assert.equal(estimateClaimsByCapacity(ckb(147n + 61n), ckb(147n)), 0);
  assert.equal(estimateClaimsByCapacity(ckb(147n * 11n + 61n), ckb(147n)), 10);
  assert.equal(estimateClaimsByCapacity(0n, ckb(147n)), 0);
});
