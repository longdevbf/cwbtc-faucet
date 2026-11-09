import { ccc } from '@ckb-ccc/ccc';
import { sameScriptType } from './script.js';
import type { Script } from './types.js';

export type LockType = Pick<Script, 'codeHash' | 'hashType'>;

/**
 * The locks the faucet sends cWBTC to: a standard CKB address (secp256k1-blake160, as Neuron and Fiber nodes use) and a
 * JoyID address. Any args of these locks is accepted. A JoyID lock has 2 more bytes of args than a standard one, so its
 * cWBTC cell needs 148 CKB instead of 147: udtCellCapacity raises the cell's capacity to that minimum.
 */
export const RECIPIENT_KNOWN_LOCKS = [ccc.KnownScript.Secp256k1Blake160, ccc.KnownScript.JoyId] as const;

export const RECIPIENT_LOCK_MESSAGE = 'Recipient must be a standard CKB address or a JoyID address';

/** Whether `lock` has the code hash and hash type of one of `allowed` (its args may be anything). */
export function isAllowedRecipientLock(lock: LockType, allowed: readonly LockType[]): boolean {
  return allowed.some((type) => sameScriptType(lock, type));
}

/** The lock types of RECIPIENT_KNOWN_LOCKS on the client's network. */
export async function recipientLockTypes(client: ccc.Client): Promise<LockType[]> {
  const infos = await Promise.all(RECIPIENT_KNOWN_LOCKS.map((known) => client.getKnownScript(known)));
  return infos.map(({ codeHash, hashType }) => ({ codeHash, hashType: hashType as LockType['hashType'] }));
}
