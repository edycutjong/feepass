// The config file deploy.ts writes. A pure merge, so it is unit-tested: deploy owns only what it derives (category,
// constructor, artifact hash, pool addresses, the BCH price the economics were checked at); every operator-set field
// already in the file (lane count, explorer, preset recipient, repo, payout address) is kept as it is.
export interface Derived {
  network: string;
  contractAddress: string;
  tokenAddress: string;
  pusdCategory: string;
  pusdDecimals: number;
  constructorArgs: { ownerPk: string; feeTokens: bigint; maxSubsidy: bigint; maxTopUp: bigint };
  artifactSha256: string;
  economicsCheckedAtBchUsd: number;
}

/** Defaults for a network that has no config file yet (chipnet / mock). Mainnet always has one: it is never synthesized. */
const FRESH = { lanes: 20, demoAmountUnits: '10' };

export function mergeDeployedConfig(existing: Record<string, unknown> | null, d: Derived): Record<string, unknown> {
  if (!existing && d.network === 'mainnet') throw new Error('src/config/mainnet.json is missing: refusing to synthesize a mainnet config');
  const base = existing ?? FRESH;
  return {
    ...base,
    network: d.network,
    contractAddress: d.contractAddress,
    tokenAddress: d.tokenAddress,
    pusdCategory: d.pusdCategory,
    pusdDecimals: d.pusdDecimals,
    constructor: {
      ownerPk: d.constructorArgs.ownerPk,
      feeTokens: String(d.constructorArgs.feeTokens),
      maxSubsidy: String(d.constructorArgs.maxSubsidy),
      maxTopUp: String(d.constructorArgs.maxTopUp),
    },
    artifactSha256: d.artifactSha256,
    economicsCheckedAtBchUsd: d.economicsCheckedAtBchUsd,
  };
}
