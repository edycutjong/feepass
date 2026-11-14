// The serverless function's routing, validation and error mapping, offline.
import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { hash160, secp256k1, sha256, utf8ToBin, encodeCashAddress } from '@bitauth/libauth';
import { handle, IpLimiter, type ApiDeps } from '../src/server/feepassApi';
import { STARTER_DEFAULTS, type FaucetChain } from '../src/core/starter';
import { PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';

const key = (s: string) => {
  const priv = sha256.hash(utf8ToBin(s));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  return { priv, pub, address: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address, tokenAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address };
};
class Chain extends MockNetworkProvider {
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
  it('health reports faucet units, BCH, claims today and open lanes', async () => {
    const { deps } = rig();
    const r = await handle(new Request('https://x.test/api/feepass?op=health'), deps, new IpLimiter());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, faucetUnits: 300, faucetBchSats: 50_000, claimUnits: 25, claimsToday: 0, dailyCap: 3, lanesOpen: 7 });
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
