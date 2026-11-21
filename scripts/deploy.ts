// "Deploys" the pool: a P2SH32 covenant needs no deploy tx, so this derives its address from the constructor args,
// asserts the economic invariants, and writes src/config/<network>.json for the app.
// Usage: tsx scripts/deploy.ts --network mock|chipnet|mainnet --bch-usd <price> [--category <display hex>] [--authorized-cap <bch>]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { poolContract } from '../src/core/pool';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY, PUSD_DECIMALS, feeCoversSubsidy } from '../src/core/params';
import { arg, hotWallet, network, provider, requireCap } from './lib';
import { mergeDeployedConfig } from './deploy-config';
import { parseConfig } from '../src/core/config';

const net = network();
requireCap(net, 0n);
const bchUsd = Number(arg('bch-usd'));
if (!(bchUsd > 0)) throw new Error('--bch-usd <price> is required (economic check)');
const category = arg('category') ?? PUSD_CATEGORY_DISPLAY;
if (net === 'mainnet' && category !== PUSD_CATEGORY_DISPLAY) throw new Error('mainnet pool must use the PUSD category');
const p = DEFAULT_PARAMS;
const hot = hotWallet(net);
const pool = poolContract({ ...p, ownerPk: hot.pub, categoryDisplay: category }, provider(net));

// Invariants (asserted before any config is written)
const TOKEN_P2PKH_DUST_MAX = 675n;
const checks: [string, boolean][] = [
  ['maxTopUp <= one token-P2PKH dust (675)', p.maxTopUp <= TOKEN_P2PKH_DUST_MAX],
  ['maxTopUp < maxSubsidy', p.maxTopUp < p.maxSubsidy],
  [`feeTokens worth >= 1.5 x maxSubsidy at BCH $${bchUsd}`, feeCoversSubsidy(p, bchUsd)],
];
// The measured fee of the real shape plus T must fit under C.
const mock = new MockNetworkProvider();
const mpool = poolContract({ ...p, ownerPk: hot.pub, categoryDisplay: category }, mock);
const probeUser = hotWallet('mock').tokenAddress;
const send = buildSponsoredSend({
  pool: mpool, params: p, categoryDisplay: category,
  userUtxo: mock.addUtxo(probeUser, randomUtxo({ satoshis: 2000n, token: { category, amount: 100n } })),
  userAddress: probeUser,
  lane: mock.addUtxo(mpool.tokenAddress, randomUtxo({ satoshis: 100_000n, token: { category, amount: 1n } })),
  recipient: probeUser,
  amount: 10n,
});
checks.push([`measured fee (${send.minerFeeSats}) + maxTopUp <= maxSubsidy`, send.minerFeeSats + p.maxTopUp <= p.maxSubsidy]);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

const artifactBytes = readFileSync(new URL('../src/contracts/FeePassPool.artifact.json', import.meta.url));
const configUrl = new URL(`../src/config/${net}.json`, import.meta.url);
// Read once and handle a missing file in the catch (no exists-then-read window).
function readExisting(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(configUrl, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
const existing = readExisting();
// Merge, never replace: lanes, explorerTx, demoRecipient (the faucet), repoUrl and payoutAddress are operator-set and kept.
const config = mergeDeployedConfig(existing, {
  network: net,
  contractAddress: pool.address,
  tokenAddress: pool.tokenAddress,
  pusdCategory: category,
  pusdDecimals: PUSD_DECIMALS,
  constructorArgs: { ownerPk: binToHex(hot.pub), feeTokens: p.feeTokens, maxSubsidy: p.maxSubsidy, maxTopUp: p.maxTopUp },
  artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
  economicsCheckedAtBchUsd: bchUsd,
});
if (net === 'mainnet') parseConfig(config as Parameters<typeof parseConfig>[0]); // the app's own parser must accept it, or nothing is written
if (net === 'mock') console.log(JSON.stringify(config, null, 2));
else writeFileSync(configUrl, JSON.stringify(config, null, 2) + '\n');
console.log(`pool ${pool.tokenAddress}`);
