// Pool lanes: the covenant's UTXOs that hold PUSD fungibles (R7). Derived from the live UTXO set, never stored.
import type { SpendableUtxo } from 'cashscript';
import { dustFor } from './dust';
import type { PoolParams } from './params';

export type LaneState = 'open' | 'busy' | 'closed';

export interface Lane {
  /** 1-based board number, by value rank (highest value = lane 1). */
  number: number;
  outpoint: string;
  utxo: SpendableUtxo;
  valueSats: bigint;
  pusdUnits: bigint;
  state: LaneState;
}

export interface Board {
  /** At most N heads: the N highest-value qualifying UTXOs (architecture §4 board rule). */
  lanes: Lane[];
  /** Coins at the pool address that are not on the board (token-less donations, NFTs, other categories, beyond N). */
  otherCoins: number;
  open: number;
  poolSats: bigint;
  poolUnits: bigint;
}

export const outpointOf = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

/** The lane's own dust after a send: a P2SH32 token output (681 sats below 253 units, 687 from 253). */
export function laneFloor(categoryDisplay: string, laneLock: Uint8Array, units: bigint, params: PoolParams): bigint {
  return params.maxSubsidy + dustFor(laneLock, { category: categoryDisplay, amount: units + params.feeTokens });
}

export function buildBoard(
  utxos: SpendableUtxo[],
  o: { categoryDisplay: string; laneLock: Uint8Array; params: PoolParams; n: number; busy?: ReadonlySet<string> },
): Board {
  const qualifying = utxos
    .filter((u) => u.token && u.token.category === o.categoryDisplay && !u.token.nft && u.token.amount > 0n)
    .sort((a, b) => (b.satoshis === a.satoshis ? outpointOf(a).localeCompare(outpointOf(b)) : b.satoshis > a.satoshis ? 1 : -1));
  const shown = qualifying.slice(0, o.n);
  const lanes = shown.map((u, k): Lane => {
    const units = u.token!.amount;
    const outpoint = outpointOf(u);
    const state: LaneState = o.busy?.has(outpoint)
      ? 'busy'
      : u.satoshis >= laneFloor(o.categoryDisplay, o.laneLock, units, o.params) ? 'open' : 'closed';
    return { number: k + 1, outpoint, utxo: u, valueSats: u.satoshis, pusdUnits: units, state };
  });
  return {
    lanes,
    otherCoins: utxos.length - shown.length,
    open: lanes.filter((l) => l.state === 'open').length,
    poolSats: shown.reduce((s, l) => s + l.satoshis, 0n),
    poolUnits: shown.reduce((s, l) => s + l.token!.amount, 0n),
  };
}

/** A uniformly random open lane not in `exclude` (F2). Three simultaneous picks over 20 open lanes share a lane 14.5% of the
 *  time (1 − 20·19·18/20³); a collision costs the loser one more signature on another lane, never a double payment. */
export function pickLane(board: Board, exclude: ReadonlySet<string>, rng: () => number = Math.random): Lane | undefined {
  const free = board.lanes.filter((l) => l.state === 'open' && !exclude.has(l.outpoint));
  if (free.length === 0) return undefined;
  return free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
}
