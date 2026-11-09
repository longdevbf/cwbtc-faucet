import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWait } from './format.js';

test('formatWait rounds up to whole minutes and shows hours past 60 minutes', () => {
  assert.equal(formatWait(1), '1 min');
  assert.equal(formatWait(0), '1 min');
  assert.equal(formatWait(17 * 60_000 + 1), '18 min');
  assert.equal(formatWait(60 * 60_000), '1 h');
  assert.equal(formatWait(1428 * 60_000), '23 h 48 min');
});
