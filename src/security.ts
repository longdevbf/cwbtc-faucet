import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { Request } from 'express';
import { ccc } from '@ckb-ccc/core';
import { config } from './config.js';
import { countClaims, hasActiveClaim, latestClaimForAddress, latestClaimForIpSince } from './db.js';
import { recipientLockError, recipientLocks } from './ckb/recipient.js';
import { formatWait } from './format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export type RecipientCheck = { ok: true; address: string } | { ok: false; error: string };

/**
 * Checks a claim's recipient (a testnet address of an accepted lock, with args of that lock's exact length) and returns
 * its canonical full-format address. Claims are stored and limited under that canonical form, so one lock written in
 * several address formats counts as one recipient.
 */
export async function resolveRecipient(address: string): Promise<RecipientCheck> {
  if (!address.startsWith('ckt1')) {
    return { ok: false, error: 'Address must be a CKB testnet address starting with ckt1' };
  }

  let client: ccc.Client;
  let script: ccc.Script;
  try {
    client = new ccc.ClientPublicTestnet({ url: config.ckbRpcUrl });
    script = (await ccc.Address.fromString(address, client)).script;
  } catch {
    return { ok: false, error: 'Invalid CKB testnet address' };
  }
  const lockError = recipientLockError(script, await recipientLocks(client));
  if (lockError) return { ok: false, error: lockError };
  return { ok: true, address: normalizeAddress(ccc.Address.fromScript(script, client).toString()) };
}

export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** IPv6 addresses an ISP or tunnel hands out together: limits count a client's whole /64 as one network. */
const IPV6_NETWORK_GROUPS = 4;
const IPV6_GROUPS = 8;
/** ::ffff:0:0/96: an IPv4 address carried in IPv6, its five zero groups then ffff, the IPv4 address in the last two. */
const IPV4_MAPPED_ZERO_GROUPS = 5;
const IPV4_MAPPED_MARK = 'ffff';
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;

/**
 * The network a request comes from, for rate limits: an IPv4 address as it is (also when written as IPv4-mapped IPv6),
 * an IPv6 address as its /64 prefix, since one client can use every address in its /64.
 */
export function clientNetwork(ip: string): string {
  const address = ip.split('%')[0];
  if (!isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  if (isIpv4Mapped(groups)) return ipv4Of(groups[IPV4_MAPPED_ZERO_GROUPS + 1], groups[IPV4_MAPPED_ZERO_GROUPS + 2]);
  return `${groups.slice(0, IPV6_NETWORK_GROUPS).join(':')}::/64`;
}

/** Whether the groups are ::ffff:a.b.c.d however the address was written (dotted, hex, with or without zeros). */
function isIpv4Mapped(groups: readonly string[]): boolean {
  return groups.slice(0, IPV4_MAPPED_ZERO_GROUPS).every((group) => group === '0') && groups[IPV4_MAPPED_ZERO_GROUPS] === IPV4_MAPPED_MARK;
}

/** The dotted IPv4 address in two hex groups ("cb00", "7107" is 203.0.113.7). */
function ipv4Of(high: string, low: string): string {
  return [parseInt(high, 16), parseInt(low, 16)].flatMap((group) => [group >> BYTE_BITS, group & BYTE_MASK]).join('.');
}

/** The eight 16-bit groups of a valid IPv6 address, in lower-case hex without leading zeros. */
function ipv6Groups(address: string): string[] {
  const [head, tail] = address.includes('::') ? address.split('::') : [address, undefined];
  const parts = (text: string | undefined): string[] => (text ? text.split(':').flatMap(embeddedIpv4Groups) : []);
  const left = parts(head);
  const right = parts(tail);
  const zeros = tail === undefined ? [] : Array<string>(IPV6_GROUPS - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16).toString(16));
}

/** A dotted IPv4 tail ("1.2.3.4") as its two hex groups; any other part unchanged. */
function embeddedIpv4Groups(part: string): string[] {
  if (!part.includes('.')) return [part];
  const [a, b, c, d] = part.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/**
 * Whether an Authorization header carries `Bearer <token>`, compared in constant time. Both sides are hashed first, so
 * the comparison takes the same time whatever the header's length and does not reveal the token's length either.
 */
export function hasBearerToken(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(`${config.ipHashSalt}:${ip}`).digest('hex');
}

export function checkClaimEligibility(address: string, ipHash: string): string | null {
  const now = Date.now();
  const dayAgo = now - DAY_MS;

  if (hasActiveClaim(address)) {
    return 'This address already has a pending claim';
  }

  const latest = latestClaimForAddress(address);
  if (latest && latest.cooldown_until > now) {
    return `This address can claim again in ${formatWait(latest.cooldown_until - now)}`;
  }

  const ipCooldownMs = config.ipCooldownSeconds * 1000;
  const latestFromIp = latestClaimForIpSince(ipHash, now - ipCooldownMs);
  if (latestFromIp) {
    return `This network can claim again in ${formatWait(latestFromIp.created_at + ipCooldownMs - now)}`;
  }

  const addressDailyCount = countClaims('address = ? AND created_at >= ?', [address, dayAgo]);
  if (addressDailyCount >= config.addressDailyClaimLimit) {
    return 'This address has reached the daily claim limit';
  }

  const ipDailyCount = countClaims('ip_hash = ? AND created_at >= ?', [ipHash, dayAgo]);
  if (ipDailyCount >= config.ipDailyClaimLimit) {
    return 'This network has reached the daily claim limit';
  }

  const globalDailyCount = countClaims('created_at >= ?', [dayAgo]);
  if (globalDailyCount >= config.globalDailyClaimLimit) {
    return 'The faucet has reached the global daily claim limit';
  }

  return null;
}

export async function verifyTurnstile(token: string | undefined, ip: string): Promise<string | null> {
  if (!config.requireTurnstile) return null;
  if (!config.turnstileSecretKey) {
    return 'Turnstile is required but TURNSTILE_SECRET_KEY is not configured';
  }
  if (!token) {
    return 'Complete the verification challenge';
  }

  const body = new URLSearchParams({
    secret: config.turnstileSecretKey,
    response: token,
    remoteip: ip,
  });
  const res = await fetch(config.turnstileVerifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    return `Turnstile verification failed with HTTP ${res.status}`;
  }
  const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
  if (!data.success) {
    return `Turnstile verification failed: ${(data['error-codes'] ?? ['unknown']).join(', ')}`;
  }
  return null;
}
