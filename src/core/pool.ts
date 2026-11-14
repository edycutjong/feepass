import { Contract, type NetworkProvider, type Artifact } from 'cashscript';
import artifactJson from '../contracts/FeePassPool.artifact.json';
import { categoryToInternalOrder, type PoolParams } from './params';

export const artifact = artifactJson as unknown as Artifact;

export interface PoolConfig extends PoolParams {
  /** Operator public key (33-byte compressed, hex or bytes). */
  ownerPk: string | Uint8Array;
  /** Token category in DISPLAY order. */
  categoryDisplay: string;
}

/** Instantiate the FeePassPool covenant (P2SH32) for a provider. */
export function poolContract(cfg: PoolConfig, provider: NetworkProvider): Contract<Artifact, any, 'p2sh32'> {
  return new Contract(
    artifact,
    [cfg.ownerPk, categoryToInternalOrder(cfg.categoryDisplay), cfg.feeTokens, cfg.maxSubsidy, cfg.maxTopUp],
    { provider, contractType: 'p2sh32' },
  );
}
