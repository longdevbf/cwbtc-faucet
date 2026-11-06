import { ccc } from '@ckb-ccc/ccc';

export const SHANNONS_PER_CKB = 100_000_000n;

/**
 * A CKB cell must hold at least as many CKB as the bytes it occupies (1 byte = 1 CKB). Every claim creates one cWBTC
 * cell for the recipient, so this capacity is what the faucet spends per claim (plus a fee of a few thousand shannons).
 * The recipient receives that CKB together with the cWBTC.
 *
 * A cWBTC cell locked by a standard secp256k1 address occupies 146 bytes:
 *
 *   capacity field                                           8
 *   lock script: code_hash 32 + hash_type 1 + args 20       53
 *   type script: code_hash 32 + hash_type 1 + args 36       69   (xUDT args: 32-byte owner lock hash + 4-byte flags)
 *   data: uint128 token amount                              16
 *                                                          ---
 *                                                          146
 *
 * An xUDT whose args carry no flags field would need 142. cWBTC's args include the 4-byte flags, hence 146.
 */
export const CWBTC_CELL_OCCUPIED_CKB = 146n;

/** Margin above the minimum: lets the recipient move the whole cell later with the fee taken from the cell itself. */
export const CWBTC_CELL_MARGIN_CKB = 1n;

/** Default for UDT_CELL_CAPACITY_CKB: 147 CKB per cWBTC cell. The upstream faucet used 200. */
export const DEFAULT_UDT_CELL_CAPACITY_CKB = CWBTC_CELL_OCCUPIED_CKB + CWBTC_CELL_MARGIN_CKB;

/** Smallest plain CKB cell for a secp256k1 lock (8 + 53 bytes); the fee change cell needs it. */
export const PLAIN_CELL_OCCUPIED_CKB = 61n;

interface OutputScripts {
  lock: ccc.ScriptLike;
  type?: ccc.ScriptLike | null;
}

/** Minimum capacity in shannons for this exact output and data, computed the way CKB consensus checks it. */
export function minimumCapacity(output: OutputScripts, outputData: ccc.HexLike): bigint {
  return ccc.CellOutput.from({ capacity: 0, lock: output.lock, type: output.type }, outputData).capacity;
}

/** The configured capacity, raised to the output's minimum if a recipient lock with longer args would need more. */
export function udtCellCapacity(configuredShannons: bigint, output: OutputScripts, outputData: ccc.HexLike): bigint {
  const minimum = minimumCapacity(output, outputData);
  return configuredShannons > minimum ? configuredShannons : minimum;
}

/**
 * Rough number of claims the faucet's CKB still covers. The faucet keeps one cWBTC change cell of its own and needs a
 * plain change cell for the fee, so that much capacity is reserved and not counted.
 */
export function estimateClaimsByCapacity(totalCapacityShannons: bigint, cellCapacityShannons: bigint): number {
  const reserve = cellCapacityShannons + PLAIN_CELL_OCCUPIED_CKB * SHANNONS_PER_CKB;
  if (cellCapacityShannons <= 0n || totalCapacityShannons <= reserve) return 0;
  return Number((totalCapacityShannons - reserve) / cellCapacityShannons);
}
