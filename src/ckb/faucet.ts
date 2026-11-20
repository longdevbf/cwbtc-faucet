import { ccc } from '@ckb-ccc/core';
import { cachedLoader } from '../cache.js';
import { config } from '../config.js';
import { parseUdtAmount } from './amount.js';
import { claimCapacityError, estimateClaimsByCapacity, udtCellCapacity } from './capacity.js';
import { recipientLockError, recipientLocks } from './recipient.js';
import { collectCellsByLock } from './rpc.js';
import { sameScript } from './script.js';
import type { Script } from './types.js';

const WBTC_TYPE_SCRIPT: Script = config.cwbtc.typeScript;
// CKB put into each cWBTC cell (UDT_CELL_CAPACITY_CKB, default 147 CKB = 146 occupied + 1 margin; upstream used 200).
const UDT_CELL_CAPACITY = config.udtCellCapacityShannons;

function getClient(): ccc.Client {
  return new ccc.ClientPublicTestnet({ url: config.ckbRpcUrl });
}

function faucetPrivateKey(): string {
  if (!config.faucetPrivateKey) {
    throw new Error('Faucet hot wallet is not configured: FAUCET_PRIVATE_KEY_FILE or FAUCET_PRIVATE_KEY is missing');
  }
  return config.faucetPrivateKey;
}

export async function getFaucetAddress(): Promise<string | null> {
  if (!config.faucetPrivateKey) return null;
  const signer = new ccc.SignerCkbPrivateKey(getClient(), config.faucetPrivateKey);
  return signer.getRecommendedAddress();
}

export async function getFaucetLockScript(): Promise<Script> {
  const signer = new ccc.SignerCkbPrivateKey(getClient(), faucetPrivateKey());
  return (await signer.getAddressObjSecp256k1()).script;
}

export interface FaucetBalances {
  configured: boolean;
  address: string | null;
  cwbtcRaw: string;
  totalCapacityShannons: string;
  plainCapacityShannons: string;
  estimatedClaimsByCwbtc: number;
  estimatedClaimsByCapacity: number;
}

export async function getFaucetBalances(): Promise<FaucetBalances> {
  const address = await getFaucetAddress();
  if (!address) {
    return {
      configured: false,
      address: null,
      cwbtcRaw: '0',
      totalCapacityShannons: '0',
      plainCapacityShannons: '0',
      estimatedClaimsByCwbtc: 0,
      estimatedClaimsByCapacity: 0,
    };
  }

  const lock = await getFaucetLockScript();
  // One paginated get_cells over the hot wallet's cells (exact lock search); the cWBTC and plain CKB cells come from it.
  const allCells = await collectCellsByLock(lock);
  const wbtcCells = allCells.filter((cell) => cell.output.type !== null && sameScript(cell.output.type, WBTC_TYPE_SCRIPT));
  const plainCells = allCells.filter((cell) => cell.output.type === null);
  const cwbtcRaw = wbtcCells.reduce((sum, cell) => sum + parseUdtAmount(cell.outputData), 0n);
  const totalCapacity = allCells.reduce((sum, cell) => sum + BigInt(cell.output.capacity), 0n);
  const plainCapacity = plainCells.reduce((sum, cell) => sum + BigInt(cell.output.capacity), 0n);
  const claimAmount = BigInt(config.claimAmountRaw);

  return {
    configured: true,
    address,
    cwbtcRaw: cwbtcRaw.toString(),
    totalCapacityShannons: totalCapacity.toString(),
    plainCapacityShannons: plainCapacity.toString(),
    estimatedClaimsByCwbtc: claimAmount > 0n ? Number(cwbtcRaw / claimAmount) : 0,
    estimatedClaimsByCapacity: estimateClaimsByCapacity(totalCapacity, UDT_CELL_CAPACITY),
  };
}

/** getFaucetBalances, reused for BALANCE_CACHE_SECONDS; concurrent callers share one lookup. For /api/balance. */
export const getCachedFaucetBalances = cachedLoader(getFaucetBalances, config.balanceCacheSeconds * 1000);

export async function transferCwbtc(recipientAddress: string, amountRaw: bigint): Promise<string> {
  const privateKey = faucetPrivateKey();
  const client = getClient();
  const signer = new ccc.SignerCkbPrivateKey(client, privateKey);
  const faucetLockScript = (await signer.getAddressObjSecp256k1()).script;
  const recipientLock = (await ccc.Address.fromString(recipientAddress, client)).script;

  // Checked again here, not only when the claim was accepted: a claim queued before a check existed is refused too.
  const lockError = recipientLockError(recipientLock, await recipientLocks(client));
  if (lockError) {
    throw new Error(lockError);
  }

  const typeScript = await ccc.Script.fromKnownScript(
    client,
    ccc.KnownScript.XUdt,
    WBTC_TYPE_SCRIPT.args,
  );
  const tx = ccc.Transaction.from({});
  const recipientData = ccc.numLeToBytes(amountRaw, 16);
  const recipientCapacity = udtCellCapacity(UDT_CELL_CAPACITY, { lock: recipientLock, type: typeScript }, recipientData);
  const capacityError = claimCapacityError(recipientCapacity, UDT_CELL_CAPACITY);
  if (capacityError) {
    throw new Error(capacityError);
  }
  tx.addOutput(
    {
      capacity: recipientCapacity,
      lock: recipientLock,
      type: typeScript,
    },
    recipientData,
  );

  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
  await tx.completeInputsByUdt(signer, typeScript);

  const inputRaw = await tx.getInputsUdtBalance(client, typeScript);
  const changeRaw = inputRaw - amountRaw;
  if (changeRaw < 0n) {
    throw new Error(`Insufficient cWBTC: have ${inputRaw.toString()}, need ${amountRaw.toString()}`);
  }
  if (changeRaw > 0n) {
    const changeData = ccc.numLeToBytes(changeRaw, 16);
    tx.addOutput(
      {
        capacity: udtCellCapacity(UDT_CELL_CAPACITY, { lock: faucetLockScript, type: typeScript }, changeData),
        lock: faucetLockScript,
        type: typeScript,
      },
      changeData,
    );
  }

  await tx.completeFeeChangeToLock(signer, faucetLockScript, 2000);
  return signer.sendTransaction(tx);
}
