// Architecture §9: the app talks to mainnet only. Every provider the browser code constructs is 'mainnet', and the built
// bundle carries no chipnet server except the library's own unused switch case (cashscript ElectrumNetworkProvider).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const browserSources = walk('src').filter((f) => /\.(ts|vue)$/.test(f) && !f.includes('headlessSigner'));

describe('mainnet only', () => {
  it('every ElectrumNetworkProvider in browser code is constructed with "mainnet"', () => {
    const calls = browserSources.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/new ElectrumNetworkProvider\(([^)]*)\)/g)].map((m) => `${f}: ${m[1]}`));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/: 'mainnet'$/);
  });
  it('no browser source names a chipnet server or the chipnet network', () => {
    for (const f of browserSources) expect(readFileSync(f, 'utf8'), f).not.toMatch(/chipnet|Network\.CHIPNET|testnet4/i);
  });
  it.skipIf(!existsSync('dist/assets'))('the built bundle has no chipnet host other than the library default case', () => {
    const hosts = readdirSync('dist/assets').filter((f) => f.endsWith('.js'))
      .flatMap((f) => readFileSync(join('dist/assets', f), 'utf8').match(/[a-z0-9.-]*chipnet[a-z0-9.-]*\.[a-z]{2,}/g) ?? []);
    expect([...new Set(hosts)].every((h) => h === 'chipnet.bch.ninja')).toBe(true);
  });
});
