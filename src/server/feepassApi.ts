// The one serverless function's logic (api/feepass.ts is a thin wrapper): `op=starter` (POST, the faucet claim) and
// `op=health` (GET). Dependencies are injected so the routing, validation and error mapping are tested offline.
import { readClaimHistory, readFaucetCoins, claimStarter, StarterError, type FaucetChain, type StarterConfig } from '../core/starter';
import type { Board } from '../core/lanes';

export interface ApiDeps {
  chain: FaucetChain;
  starter: StarterConfig;
  /** Open lanes on the pool, read by the same board rule the app uses. Null when the read failed. */
  board(): Promise<Board | null>;
  now?: () => number;
  /** A claim that has not finished by then answers BUSY and stops holding the instance's claim queue (default 20 s). */
  claimTimeoutMs?: number;
}

const HTTP: Record<StarterError['code'], number> = {
  BAD_ADDRESS: 400, SELF: 400, ALREADY_CLAIMED: 409, DAILY_CAP: 429, FAUCET_EMPTY: 503, FAUCET_NO_BCH: 503, BUSY: 503, DUST: 500, CHAIN: 502,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Best-effort per-IP limit, in memory: it does not survive a cold start and is NOT a guarantee (the UI says so). */
export class IpLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 3, private windowMs = 3_600_000) {}
  allow(ip: string, nowMs: number): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(ip, recent); return false; }
    recent.push(nowMs);
    this.hits.delete(ip);
    this.hits.set(ip, recent); // re-inserted: Map order = least recently seen first
    // bounded memory: evict the least recently seen keys, never everyone's window at once
    for (const k of this.hits.keys()) { if (this.hits.size <= 5000) break; this.hits.delete(k); }
    return true;
  }
}

let healthCache: { at: number; key: string; body: unknown } | null = null;
/** Concurrent misses share one read: the history scan is one raw-tx fetch per faucet history entry. */
let healthInFlight: { key: string; p: Promise<{ body: unknown; cacheable: boolean }> } | null = null;
const HEALTH_TTL_MS = 30_000;
/** Test hook: forget the cached health answer. */
export const resetHealthCache = () => { healthCache = null; healthInFlight = null; };

/** Claims in one instance run one at a time, so the second sees the first in the chain before it is built. Across
 *  instances the chain itself serializes them (starter.ts header). */
let claimQueue: Promise<unknown> = Promise.resolve();

/** Vercel sets x-real-ip (and overwrites x-forwarded-for) with the connecting client's address; the leftmost
 *  x-forwarded-for entry is the fallback. Either way the limit is best effort and documented as such. */
export function clientIp(req: Request): string {
  return (req.headers.get('x-real-ip') ?? '').trim() || (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
}

async function readHealth(deps: ApiDeps): Promise<{ body: unknown; cacheable: boolean }> {
  const [coins, hist, board] = await Promise.allSettled([readFaucetCoins(deps.chain, deps.starter), readClaimHistory(deps.chain, deps.starter), deps.board()]);
  const faucetUnits = coins.status === 'fulfilled' ? Number(coins.value.units) : null;
  const body = {
    ok: coins.status === 'fulfilled' && board.status === 'fulfilled' && board.value !== null,
    faucetUnits,
    faucetBchSats: coins.status === 'fulfilled' ? Number(coins.value.bch.reduce((s, u) => s + u.satoshis, 0n)) : null,
    claimUnits: Number(deps.starter.claimUnits),
    claimsToday: hist.status === 'fulfilled' ? hist.value.claimsToday : null,
    dailyCap: deps.starter.dailyCap,
    lanesOpen: board.status === 'fulfilled' && board.value ? board.value.open : null,
    historyTruncated: hist.status === 'fulfilled' ? hist.value.historyTruncated : null,
    /** True when today's claims cannot be counted (truncated history inside today): claims are refused until 00:00 UTC. */
    claimsPaused: hist.status === 'fulfilled' ? !hist.value.coversToday : null,
  };
  return { body, cacheable: body.ok && hist.status === 'fulfilled' }; // a partial failure is never cached
}

export async function handle(req: Request, deps: ApiDeps, limiter: IpLimiter): Promise<Response> {
  const url = new URL(req.url);
  const op = url.searchParams.get('op');
  const nowMs = (deps.now ?? Date.now)();

  if (op === 'health') {
    if (req.method !== 'GET') return json(405, { error: 'Use GET.' });
    // Unauthenticated and the history read is heavy (one raw tx per faucet history entry): cached for 30 s per instance.
    if (healthCache && nowMs - healthCache.at < HEALTH_TTL_MS && healthCache.key === deps.starter.faucetAddress) return json(200, healthCache.body);
    const key = deps.starter.faucetAddress;
    if (!healthInFlight || healthInFlight.key !== key) {
      const mine: { key: string; p: Promise<{ body: unknown; cacheable: boolean }> } = { key, p: readHealth(deps) };
      healthInFlight = mine;
      void mine.p.finally(() => { if (healthInFlight === mine) healthInFlight = null; }).catch(() => undefined);
    }
    const { body, cacheable } = await healthInFlight.p;
    if (cacheable) healthCache = { at: nowMs, key: deps.starter.faucetAddress, body };
    return json(200, body);
  }

  if (op === 'starter') {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
    const text = await req.text();
    if (text.length > 2048) return json(413, { error: 'Request too large.' });
    let address: unknown;
    try { address = (JSON.parse(text) as { address?: unknown }).address; } catch { return json(400, { error: 'Send JSON: {"address": "bitcoincash:…"}' }); }
    if (typeof address !== 'string') return json(400, { error: 'Send JSON: {"address": "bitcoincash:…"}' });
    if (!limiter.allow(clientIp(req), nowMs)) return json(429, { error: 'Too many claims from this network just now. Try again later.', code: 'IP_LIMIT' });
    try {
      const deadline = deps.claimTimeoutMs ?? 20_000;
      const run = claimQueue.then(() => {
        let t: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new StarterError('BUSY', 'The network is slow to answer. Try again in a moment.')), deadline); });
        return Promise.race([claimStarter(deps.chain, deps.starter, address), timeout]).finally(() => clearTimeout(t));
      });
      claimQueue = run.catch(() => undefined); // a failed or timed-out claim never blocks the next one
      const r = await run;
      return json(200, { txid: r.txid, units: Number(r.units), claimsToday: r.claimsToday, dailyCap: deps.starter.dailyCap });
    } catch (e) {
      if (e instanceof StarterError) return json(HTTP[e.code], { error: e.message, code: e.code });
      return json(500, { error: 'Unexpected error. Try again.', code: 'INTERNAL' });
    }
  }
  return json(404, { error: 'Unknown op. Use ?op=health or POST ?op=starter.' });
}
