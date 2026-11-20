import assert from 'node:assert/strict';
import test from 'node:test';
import { ccc } from '@ckb-ccc/ccc';
import {
  CLAIM_CAPACITY_MARGIN_CKB,
  CWBTC_CELL_OCCUPIED_CKB,
  DEFAULT_UDT_CELL_CAPACITY_CKB,
  SHANNONS_PER_CKB,
  claimCapacityError,
  estimateClaimsByCapacity,
  maxClaimCellCapacity,
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

// F1 backstop: no claim's cWBTC cell may hold more than the configured capacity plus a 2 CKB margin.

const joyIdLock: ccc.ScriptLike = {
  codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac',
  hashType: 'type',
  args: `0x0001${'22'.repeat(20)}`,
};

test('the claim capacity margin is 2 CKB above the configured capacity', () => {
  assert.equal(CLAIM_CAPACITY_MARGIN_CKB, 2n);
  assert.equal(maxClaimCellCapacity(ckb(147n)), ckb(149n));
  assert.equal(maxClaimCellCapacity(ckb(200n)), ckb(202n));
  assert.equal(maxClaimCellCapacity(ckb(146n) + 50_000_000n), ckb(148n) + 50_000_000n);
});

test('claimCapacityError accepts a cell under or at the limit', () => {
  const configured = ckb(147n);
  assert.equal(claimCapacityError(ckb(146n), configured), null);
  assert.equal(claimCapacityError(configured, configured), null);
  assert.equal(claimCapacityError(ckb(148n), configured), null);
  assert.equal(claimCapacityError(ckb(149n) - 1n, configured), null);
  assert.equal(claimCapacityError(ckb(149n), configured), null);
});

test('claimCapacityError refuses a cell one shannon over the limit, and far over it', () => {
  const configured = ckb(147n);
  assert.equal(
    claimCapacityError(ckb(149n) + 1n, configured),
    'This address would need 149.00000001 CKB in its cWBTC cell, more than the faucet gives per claim ' +
      '(at most 149 CKB). Use a standard CKB address or a JoyID address.',
  );
  assert.match(claimCapacityError(ckb(726n), configured) ?? '', /would need 726 CKB .*\(at most 149 CKB\)/);
  assert.match(claimCapacityError(ckb(203n), ckb(200n)) ?? '', /would need 203 CKB .*\(at most 202 CKB\)/);
  assert.equal(claimCapacityError(ckb(202n), ckb(200n)), null);
});

test('real cells: a standard or JoyID cell is within the limit, a cell with longer lock args is not', () => {
  const configured = ckb(DEFAULT_UDT_CELL_CAPACITY_CKB);
  const capacityFor = (lock: ccc.ScriptLike): bigint => udtCellCapacity(configured, { lock, type: cwbtcType }, amountData);
  const secpWith = (bytes: number): ccc.ScriptLike => ({ ...secp256k1Lock, args: `0x${'11'.repeat(bytes)}` });

  assert.equal(claimCapacityError(capacityFor(secp256k1Lock), configured), null);
  assert.equal(capacityFor(joyIdLock), ckb(148n));
  assert.equal(claimCapacityError(capacityFor(joyIdLock), configured), null);
  // 23 bytes of args: a 149 CKB cell, exactly at the limit. 24 bytes: 150 CKB, over it.
  assert.equal(capacityFor(secpWith(23)), ckb(149n));
  assert.equal(claimCapacityError(capacityFor(secpWith(23)), configured), null);
  assert.equal(capacityFor(secpWith(24)), ckb(150n));
  assert.match(claimCapacityError(capacityFor(secpWith(24)), configured) ?? '', /would need 150 CKB/);
  // The long-args attack from src/ckb/recipient.ts: 580 bytes of args (146 + 560) would cost 706 CKB per claim.
  assert.equal(capacityFor(secpWith(580)), ckb(706n));
  assert.match(claimCapacityError(capacityFor(secpWith(580)), configured) ?? '', /would need 706 CKB/);
});

test('with the smallest allowed configured capacity (146 CKB) a JoyID cell still fits the margin', () => {
  const configured = ckb(CWBTC_CELL_OCCUPIED_CKB);
  const capacity = udtCellCapacity(configured, { lock: joyIdLock, type: cwbtcType }, amountData);
  assert.equal(capacity, ckb(148n));
  assert.equal(claimCapacityError(capacity, configured), null);
});
