import { ccc } from '@ckb-ccc/core';
import { sameScriptType } from './script.js';
import type { Script } from './types.js';

export type LockType = Pick<Script, 'codeHash' | 'hashType'>;

/** A recipient lock type on one network, with the only args length the faucet accepts for it. */
export interface RecipientLock extends LockType {
  /** For messages: "standard CKB" or "JoyID". */
  name: string;
  argsBytes: number;
}

/**
 * The locks the faucet sends cWBTC to, each with the exact length of its args:
 *
 *   standard CKB address (secp256k1-blake160, as Neuron and Fiber nodes use)   20 bytes: blake160 of the public key
 *   JoyID address                                                              22 bytes: 2-byte mode + 20-byte hash
 *
 * A JoyID cWBTC cell needs 148 CKB instead of 147: udtCellCapacity raises the cell's capacity to that minimum. Any other
 * args length is refused. A full-format address can carry hundreds of bytes of args, and every byte costs the faucet
 * 1 CKB more in the recipient's cell: about 600 bytes would make one claim cost about 725 CKB instead of 147.
 */
export const RECIPIENT_LOCKS = [
  { known: ccc.KnownScript.Secp256k1Blake160, name: 'standard CKB', argsBytes: 20 },
  { known: ccc.KnownScript.JoyId, name: 'JoyID', argsBytes: 22 },
] as const;

export const RECIPIENT_KNOWN_LOCKS = RECIPIENT_LOCKS.map((lock) => lock.known);

export const RECIPIENT_LOCK_MESSAGE = 'Recipient must be a standard CKB address or a JoyID address';

/** Whether `lock` has the code hash and hash type of one of `allowed`. Its args are checked by recipientLockError. */
export function isAllowedRecipientLock(lock: LockType, allowed: readonly LockType[]): boolean {
  return allowed.some((type) => sameScriptType(lock, type));
}

/**
 * Why the faucet refuses to send to `lock`, or null when it accepts it: the lock must have the type of one of `allowed`
 * (recipientLocks) and args of exactly that lock's length.
 */
export function recipientLockError(lock: Script, allowed: readonly RecipientLock[]): string | null {
  const expected = allowed.find((type) => sameScriptType(lock, type));
  if (!expected) return RECIPIENT_LOCK_MESSAGE;
  const argsBytes = ccc.bytesFrom(lock.args).length;
  if (argsBytes === expected.argsBytes) return null;
  return (
    `This ${expected.name} address has ${argsBytes} bytes of lock args; the faucet only sends to ${expected.name} ` +
    `addresses with ${expected.argsBytes}. Copy the address from your wallet again.`
  );
}

/** RECIPIENT_LOCKS on the client's network. */
export async function recipientLocks(client: ccc.Client): Promise<RecipientLock[]> {
  return Promise.all(
    RECIPIENT_LOCKS.map(async ({ known, name, argsBytes }) => {
      const { codeHash, hashType } = await client.getKnownScript(known);
      return { codeHash, hashType: hashType as LockType['hashType'], name, argsBytes };
    }),
  );
}

/** The lock types of RECIPIENT_KNOWN_LOCKS on the client's network (recipientLocks without the args lengths). */
export async function recipientLockTypes(client: ccc.Client): Promise<LockType[]> {
  const locks = await recipientLocks(client);
  return locks.map(({ codeHash, hashType }) => ({ codeHash, hashType }));
}
