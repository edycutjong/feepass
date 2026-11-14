// PUSD amounts (base units, 2 decimals) and recipient addresses, validated before anything is built or signed.
import { cashAddressToLockingBytecode, decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

export function formatUnits(units: bigint, decimals = 2): string {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${(a / base).toString()}${decimals ? '.' + frac : ''}`;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** "1", "1.5", "1.50", ".25" → base units. Rejects more decimals than the token has, signs, exponents and zero. */
export function parseUnits(input: string, decimals = 2): ParseResult<bigint> {
  const s = input.trim();
  if (!s) return { ok: false, reason: 'Enter an amount.' };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, reason: 'Use digits and one decimal point, e.g. 1.50.' };
  const frac = m[2] ?? '';
  if (frac.length > decimals) return { ok: false, reason: `PUSD has ${decimals} decimals (smallest step 0.01).` };
  const units = BigInt((m[1] || '0') + frac.padEnd(decimals, '0'));
  if (units <= 0n) return { ok: false, reason: 'Amount must be at least 0.01 PUSD.' };
  return { ok: true, value: units };
}

/**
 * A mainnet P2PKH recipient, returned in its token-aware form (same key, same locking script). Accepts the plain `q…` form
 * and a missing `bitcoincash:` prefix. Refuses testnet prefixes (mainnet only) and script (P2SH) addresses: a P2SH32 token
 * output's dust (681+ sats) exceeds the covenant's top-up cap T, and the shape only pays P2PKH outputs.
 */
export function parseRecipient(input: string): ParseResult<string> {
  let s = input.trim();
  if (!s) return { ok: false, reason: 'Paste a Bitcoin Cash address.' };
  if (!s.includes(':')) s = `bitcoincash:${s}`;
  s = s.toLowerCase();
  const prefix = s.slice(0, s.indexOf(':'));
  if (prefix !== 'bitcoincash')
    return { ok: false, reason: prefix === 'bchtest' || prefix === 'bchreg' ? 'That is a test-network address. FeePass runs on mainnet only.' : 'Not a Bitcoin Cash address.' };
  const d = decodeCashAddress(s);
  if (typeof d === 'string') return { ok: false, reason: 'Not a valid Bitcoin Cash address (checksum or format).' };
  if (d.type !== 'p2pkh' && d.type !== 'p2pkhWithTokens')
    return { ok: false, reason: 'Send to a regular wallet address (starts with q or z). Script addresses are not supported.' };
  const tokenAddress = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: d.payload }).address;
  if (typeof cashAddressToLockingBytecode(tokenAddress) === 'string') return { ok: false, reason: 'Not a valid address.' };
  return { ok: true, value: tokenAddress };
}

export function shortHex(h: string, head = 6, tail = 6): string {
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function shortAddress(a: string): string {
  const body = a.includes(':') ? a.slice(a.indexOf(':') + 1) : a;
  return `${a.includes(':') ? a.slice(0, a.indexOf(':') + 1) : ''}${shortHex(body, 6, 6)}`;
}
