// Pool parameters and the PUSD token. Values are the P0c configuration; scripts/deploy.ts re-asserts the invariants.

/** PUSD (ParyonUSD) category id in DISPLAY order, as explorers and Electrum servers show it. */
export const PUSD_CATEGORY_DISPLAY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
/** PUSD has 2 decimals: 1 base unit = 0.01 PUSD. */
export const PUSD_DECIMALS = 2;

export interface PoolParams {
  /** f: PUSD base units the pool receives per sponsored send. */
  feeTokens: bigint;
  /** C: max sats one lane may lose in one transaction. */
  maxSubsidy: bigint;
  /** T: max sats the user-side outputs may exceed the user's input sats. */
  maxTopUp: bigint;
}

export const DEFAULT_PARAMS: PoolParams = { feeTokens: 1n, maxSubsidy: 2000n, maxTopUp: 675n };

/** Seed placed in every lane so `tx.inputs[1].tokenCategory == pusdCategory` (R7) holds. */
export const LANE_SEED_UNITS = 1n;

/** Display-order category hex → the internal byte order the covenant compares against. */
export function categoryToInternalOrder(displayHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(displayHex)) throw new Error(`not a 32-byte hex category: ${displayHex}`);
  return displayHex.match(/../g)!.reverse().join('');
}

/** Economic margin check used by deploy.ts: f must be worth at least 1.5 × C at the given BCH/USD price. */
export function feeCoversSubsidy(p: PoolParams, bchUsd: number, decimals = PUSD_DECIMALS): boolean {
  const feeUsd = Number(p.feeTokens) / 10 ** decimals;
  const capUsd = (Number(p.maxSubsidy) / 1e8) * bchUsd;
  return feeUsd >= 1.5 * capUsd;
}
