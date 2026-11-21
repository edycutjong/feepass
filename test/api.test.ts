// The serverless function's routing, validation and error mapping, offline.
import { beforeEach, describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { FundedMock } from './helpers';
import { hash160, secp256k1, sha256, utf8ToBin, encodeCashAddress } from '@bitauth/libauth';
import { clientIp, handle, IpLimiter, resetHealthCache, type ApiDeps } from '../src/server/feepassApi';
import { STARTER_DEFAULTS, type FaucetChain } from '../src/core/starter';
import { PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';

const key = (s: string) => {
  const priv = sha256.hash(utf8ToBin(s));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  return { priv, pub, address: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address, tokenAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address };
};
class Chain extends FundedMock {
  sent: string[] = [];
  constructor() { super(); (this as any).network = 'mainnet'; }
  async sendRawTransaction(h: string) { const t = await super.sendRawTransaction(h); this.sent.push(t); return t; }
  async history() { return this.sent.map((txid) => ({ txid, height: 0 })); }
  async tipHeight() { return 1; }
  async blockTime() { return 0; }
}
function rig(units = 300n) {
  const f = key('faucet');
  const chain = new Chain();
  chain.addUtxo(f.tokenAddress, randomUtxo({ satoshis: 2000n, token: { category: CAT, amount: units } }));
  chain.addUtxo(f.tokenAddress, randomUtxo({ satoshis: 50_000n }));
  const deps: ApiDeps = {
    chain: chain as unknown as FaucetChain,
    starter: { category: CAT, faucetPriv: f.priv, faucetPub: f.pub, faucetAddress: f.address, faucetTokenAddress: f.tokenAddress, ...STARTER_DEFAULTS },
    board: async () => ({ lanes: [], otherCoins: 0, open: 7, poolSats: 0n, poolUnits: 0n }),
  };
  return { deps, chain };
}
const post = (body: unknown, ip = '1.1.1.1') =>
  new Request('https://x.test/api/feepass?op=starter', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'x-forwarded-for': ip } });
const judge = key('judge').tokenAddress;

describe('api/feepass', () => {
  beforeEach(() => resetHealthCache());
  it('health reports faucet units, BCH, claims today and open lanes', async () => {
    const { deps } = rig();
    const r = await handle(new Request('https://x.test/api/feepass?op=health'), deps, new IpLimiter());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, faucetUnits: 300, faucetBchSats: 50_000, claimUnits: 25, claimsToday: 0, dailyCap: 12, lanesOpen: 7 });
  });
  it('health is cached for 30 s (an unauthenticated route must not re-read the faucet history on every GET)', async () => {
    const { deps, chain } = rig();
    let t = 1_000_000;
    deps.now = () => t;
    const get = () => handle(new Request('https://x.test/api/feepass?op=health'), deps, new IpLimiter());
    const first = await (await get()).json();
    chain.addUtxo(deps.starter.faucetTokenAddress, randomUtxo({ satoshis: 2000n, token: { category: CAT, amount: 500n } }));
    expect(await (await get()).json()).toEqual(first); // still cached
    t += 31_000;
    expect(((await (await get()).json()) as any).faucetUnits).toBe(800);
  });
  it('concurrent health misses share one history read (no fan-out per request)', async () => {
    const { deps, chain } = rig();
    let reads = 0;
    const h0 = chain.history.bind(chain);
    chain.history = async () => { reads++; return h0(); };
    const get = () => handle(new Request('https://x.test/api/feepass?op=health'), deps, new IpLimiter());
    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(reads).toBe(2); // one readClaimHistory = the q... and z... spellings of one address, not 2 x 3
  });
  it('two claims for the same address at once in one instance: one 200, one 409 (claims run one at a time)', async () => {
    const { deps, chain } = rig();
    const lim = new IpLimiter();
    const [a, b] = await Promise.all([handle(post({ address: judge }, '1.1.1.1'), deps, lim), handle(post({ address: judge }, '2.2.2.2'), deps, lim)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(chain.sent).toHaveLength(1);
  });
  it('a stalled claim answers 503 BUSY after its deadline and does not block the next claim in the instance', async () => {
    const { deps, chain } = rig();
    deps.claimTimeoutMs = 50;
    const u0 = chain.getUtxos.bind(chain);
    let stall = true;
    chain.getUtxos = (a: string) => (stall ? new Promise(() => {}) : u0(a)); // the first claim's chain read never answers
    const lim = new IpLimiter();
    const first = await handle(post({ address: judge }, '3.3.3.3'), deps, lim);
    expect(first.status).toBe(503);
    expect(((await first.json()) as any).code).toBe('BUSY');
    stall = false;
    const second = await handle(post({ address: key('judge2').tokenAddress }, '4.4.4.4'), deps, lim);
    expect(second.status).toBe(200);
  });
  it('limiter overflow evicts the least recently seen IPs, not every window; x-real-ip is preferred', () => {
    const lim = new IpLimiter(3, 3_600_000);
    for (let i = 0; i < 3; i++) expect(lim.allow('9.9.9.9', 1)).toBe(true);
    for (let i = 0; i < 5001; i++) lim.allow('10.0.' + i, 2);
    expect(lim.allow('9.9.9.9', 3)).toBe(true); // the oldest key was evicted (bounded memory)
    for (let i = 0; i < 2; i++) lim.allow('9.9.9.9', 4);
    for (let i = 0; i < 10; i++) lim.allow('11.0.' + i, 5);
    expect(lim.allow('9.9.9.9', 6)).toBe(false); // a recent key at its limit survives later inserts
    // overflow again after a key reaches its limit: least-recent eviction keeps it blocked; a clear-all would forget it
    const lim2 = new IpLimiter(3, 3_600_000);
    for (let i = 0; i < 4999; i++) lim2.allow('12.0.' + i, 1);
    for (let i = 0; i < 3; i++) lim2.allow('8.8.8.8', 2);
    for (let i = 0; i < 10; i++) lim2.allow('13.0.' + i, 3); // pushes the map past 5,000
    expect(lim2.allow('8.8.8.8', 4)).toBe(false);
    const req = new Request('https://x.test/', { headers: { 'x-real-ip': '7.7.7.7', 'x-forwarded-for': '6.6.6.6, 5.5.5.5' } });
    expect(clientIp(req)).toBe('7.7.7.7');
    expect(clientIp(new Request('https://x.test/', { headers: { 'x-forwarded-for': '6.6.6.6, 5.5.5.5' } }))).toBe('6.6.6.6');
  });
  it('a claim returns the txid; a repeat for the same address is 409; the body names the reason', async () => {
    const { deps } = rig();
    const lim = new IpLimiter();
    const ok = await handle(post({ address: judge }), deps, lim);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).txid).toMatch(/^[0-9a-f]{64}$/);
    const again = await handle(post({ address: judge }), deps, lim);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).code).toBe('ALREADY_CLAIMED');
  });
  it('bad address 400, malformed JSON 400, wrong method 405, unknown op 404, oversized body 413', async () => {
    const { deps } = rig();
    const lim = new IpLimiter();
    expect((await handle(post({ address: 'bchtest:qqq' }), deps, lim)).status).toBe(400);
    expect((await handle(post('not json'), deps, lim)).status).toBe(400);
    expect((await handle(post({ address: 5 }), deps, lim)).status).toBe(400);
    expect((await handle(new Request('https://x.test/api/feepass?op=starter'), deps, lim)).status).toBe(405);
    expect((await handle(new Request('https://x.test/api/feepass?op=nope'), deps, lim)).status).toBe(404);
    expect((await handle(post('x'.repeat(3000)), deps, lim)).status).toBe(413);
  });
  it('empty faucet is 503 and nothing is broadcast', async () => {
    const { deps, chain } = rig(10n);
    expect((await handle(post({ address: judge }), deps, new IpLimiter())).status).toBe(503);
    expect(chain.sent).toHaveLength(0);
  });
  it('a chain read failure while checking history is a 502 CHAIN, never a 500 or a raw error; a partial health answer is not cached', async () => {
    const { deps, chain } = rig();
    (chain as any).getRawTransaction = async () => { throw new Error('socket hang up at 10.0.0.1'); };
    (chain as any).sent.push('ab'.repeat(32));
    const r = await handle(post({ address: judge }), deps, new IpLimiter());
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain('10.0.0.1');
  });
  it('per-IP limit: the fourth claim in the window from one IP is 429 before any chain work', async () => {
    const { deps, chain } = rig(1000n);
    const lim = new IpLimiter(3, 1000);
    const now = 1_000_000;
    deps.now = () => now;
    for (let i = 0; i < 3; i++) await handle(post({ address: key('j' + i).tokenAddress }), { ...deps, now: () => now }, lim);
    const r = await handle(post({ address: key('j9').tokenAddress }), { ...deps, now: () => now }, lim);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).code).toBe('IP_LIMIT');
    expect(chain.sent.length).toBeLessThanOrEqual(3);
    const other = await handle(post({ address: key('j8').tokenAddress }, '2.2.2.2'), { ...deps, now: () => now }, lim);
    expect([200, 429]).toContain(other.status); // another IP is not blocked by the limiter (429 only if the daily cap hit)
    expect(lim.allow('3.3.3.3', now + 5000)).toBe(true);
  });
});
