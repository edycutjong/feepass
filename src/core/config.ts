// The deployed configuration the app runs on. Every number the UI prints about the pool (fee, caps, lane count) comes from
// here, never from a string in a component. The contract address is derived from the constructor, not typed in.
import type { NetworkProvider } from 'cashscript';
import raw from '../config/mainnet.json';
import { poolContract } from './pool';
import type { PoolParams } from './params';

export interface AppConfig {
  network: 'mainnet';
  categoryDisplay: string;
  decimals: number;
  ownerPk: string;
  params: PoolParams;
  lanes: number;
  artifactSha256: string;
  explorerTx: string;
  demoRecipient: string;
  demoAmountUnits: bigint;
  repoUrl: string;
}

export class ConfigError extends Error {}

/** Refuses to produce a config for anything but mainnet (architecture §9.3): the send form never renders without one. */
export function parseConfig(j: typeof raw): AppConfig {
  if (j.network !== 'mainnet') throw new ConfigError(`config network is "${j.network}", the app only runs on mainnet`);
  if (!/^[0-9a-f]{64}$/.test(j.pusdCategory)) throw new ConfigError('pusdCategory must be 32-byte display-order hex');
  if (!j.explorerTx.startsWith('https://')) throw new ConfigError('explorerTx must be an https URL');
  if (!j.demoRecipient.startsWith('bitcoincash:z')) throw new ConfigError('demoRecipient must be a mainnet token-aware address');
  const params: PoolParams = {
    feeTokens: BigInt(j.constructor.feeTokens),
    maxSubsidy: BigInt(j.constructor.maxSubsidy),
    maxTopUp: BigInt(j.constructor.maxTopUp),
  };
  if (params.maxTopUp >= params.maxSubsidy) throw new ConfigError('maxTopUp must be below maxSubsidy');
  return {
    network: 'mainnet',
    categoryDisplay: j.pusdCategory,
    decimals: j.pusdDecimals,
    ownerPk: j.constructor.ownerPk,
    params,
    lanes: j.lanes,
    artifactSha256: j.artifactSha256,
    explorerTx: j.explorerTx,
    demoRecipient: j.demoRecipient,
    demoAmountUnits: BigInt(j.demoAmountUnits),
    repoUrl: j.repoUrl,
  };
}

export const config: AppConfig = parseConfig(raw);

export function appPool(cfg: AppConfig, provider: NetworkProvider) {
  return poolContract({ ...cfg.params, ownerPk: cfg.ownerPk, categoryDisplay: cfg.categoryDisplay }, provider);
}
