export const CWBTC_DECIMALS = 100_000_000n;

export function formatCwbtc(rawAmount: string | bigint): string {
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount);
  const whole = raw / CWBTC_DECIMALS;
  const fraction = raw % CWBTC_DECIMALS;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

/** CKB also has 8 decimals: 1 CKB = 100,000,000 shannons. */
export function formatCkb(shannons: string | bigint): string {
  return formatCwbtc(shannons);
}

export function bigIntToHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** A wait in whole minutes, rounded up, as "18 min" or "23 h 48 min" (never "0 min" while any time is left). */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MS_PER_MINUTE));
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
