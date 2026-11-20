import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep a developer's .env out of these tests: dotenv/config reads DOTENV_CONFIG_PATH, and this file does not exist.
process.env.DOTENV_CONFIG_PATH = join(tmpdir(), 'cwbtc-faucet-test-no-such.env');
process.env.DATABASE_PATH = ':memory:';

type Config = (typeof import('./config.js'))['config'];

let instance = 0;

/** A fresh evaluation of src/config.ts with BALANCE_CACHE_SECONDS set to `value` (undefined: not set). */
async function configWith(value: string | undefined): Promise<Config> {
  if (value === undefined) delete process.env.BALANCE_CACHE_SECONDS;
  else process.env.BALANCE_CACHE_SECONDS = value;
  try {
    instance += 1;
    const mod = (await import(`./config.js?instance=${instance}`)) as typeof import('./config.js');
    return mod.config;
  } finally {
    delete process.env.BALANCE_CACHE_SECONDS;
  }
}

test('BALANCE_CACHE_SECONDS defaults to 60 when unset or empty', async () => {
  assert.equal((await configWith(undefined)).balanceCacheSeconds, 60);
  assert.equal((await configWith('')).balanceCacheSeconds, 60);
});

test('BALANCE_CACHE_SECONDS takes a number of seconds, including 0 and fractions', async () => {
  assert.equal((await configWith('120')).balanceCacheSeconds, 120);
  assert.equal((await configWith('0')).balanceCacheSeconds, 0);
  assert.equal((await configWith('1.5')).balanceCacheSeconds, 1.5);
  assert.equal((await configWith(' 30 ')).balanceCacheSeconds, 30);
});

test('BALANCE_CACHE_SECONDS that is not a finite number stops the config from loading', async () => {
  for (const value of ['abc', '60s', 'Infinity', 'NaN']) {
    await assert.rejects(configWith(value), /^Error: BALANCE_CACHE_SECONDS must be a number$/, value);
  }
});

test('a negative BALANCE_CACHE_SECONDS stops the config from loading', async () => {
  for (const value of ['-1', '-0.5', '-86400']) {
    await assert.rejects(configWith(value), /^Error: BALANCE_CACHE_SECONDS must be 0 or more$/, value);
  }
});
