// deploy.ts merges into src/config/<network>.json: it must never drop the operator-set fields the app needs.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeDeployedConfig, type Derived } from '../scripts/deploy-config';
import { parseConfig } from '../src/core/config';

const current = JSON.parse(readFileSync(new URL('../src/config/mainnet.json', import.meta.url), 'utf8')) as any;
const derived = (o: Partial<Derived> = {}): Derived => ({
  network: 'mainnet', contractAddress: 'bitcoincash:p-test', tokenAddress: 'bitcoincash:r-test',
  pusdCategory: current.pusdCategory, pusdDecimals: 2,
  constructorArgs: { ownerPk: current.constructor.ownerPk, feeTokens: 1n, maxSubsidy: 2000n, maxTopUp: 675n },
  artifactSha256: 'ab'.repeat(32), economicsCheckedAtBchUsd: 230, ...o,
});

describe('deploy config merge', () => {
  it('keeps lanes, explorer, preset recipient, repo and payout address; the app parser accepts the result', () => {
    const merged = mergeDeployedConfig(current, derived()) as any;
    for (const k of ['lanes', 'explorerTx', 'demoRecipient', 'demoAmountUnits', 'repoUrl', 'payoutAddress']) expect(merged[k]).toEqual(current[k]);
    expect(merged.lanes).toBeGreaterThan(0);
    expect(merged.artifactSha256).toBe('ab'.repeat(32));
    expect(() => parseConfig(merged as Parameters<typeof parseConfig>[0])).not.toThrow();
    expect(parseConfig(merged as Parameters<typeof parseConfig>[0]).params.maxSubsidy).toBe(2000n);
  });
  it('updates only what deploy derives (constructor values, category, hash)', () => {
    const merged = mergeDeployedConfig(current, derived({ constructorArgs: { ownerPk: '02' + '11'.repeat(32), feeTokens: 2n, maxSubsidy: 1500n, maxTopUp: 600n } })) as any;
    expect(merged.constructor).toEqual({ ownerPk: '02' + '11'.repeat(32), feeTokens: '2', maxSubsidy: '1500', maxTopUp: '600' });
    expect(merged.payoutAddress).toBe(current.payoutAddress);
  });
  it('refuses to synthesize a mainnet config from nothing; a fresh test-network config gets 20 lanes', () => {
    expect(() => mergeDeployedConfig(null, derived())).toThrow(/refusing/);
    expect((mergeDeployedConfig(null, derived({ network: 'chipnet' })) as Record<string, any>).lanes).toBe(20);
  });
});
