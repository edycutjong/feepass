// Reads the connected wallet's coins on mainnet from the addresses the app derives itself (hdAddresses.ts).
import type { SpendableUtxo } from 'cashscript';
import type { DerivedAddress } from './hdAddresses';
import type { PoolParams } from './params';

export interface UserCoin extends SpendableUtxo {
  owner: DerivedAddress;
}

export interface WalletScan {
  coins: UserCoin[];
  pusdUnits: bigint;
  /** Sum of non-token UTXOs over the derived addresses. null when any lookup failed: unknown is never shown as 0. */
  spendableBchSats: bigint | null;
  failedLookups: number;
  lookups: number;
}

export async function scanWallet(
  provider: { getUtxos(address: string): Promise<SpendableUtxo[]> },
  addresses: DerivedAddress[],
  categoryDisplay: string,
): Promise<WalletScan> {
  const coins: UserCoin[] = [];
  let bch = 0n;
  // allSettled: one failing lookup must not hide the coins found at the others.
  const settled = await Promise.allSettled(
    addresses.map(async (a) => {
      for (const u of await provider.getUtxos(a.address)) {
        if (!u.token) bch += u.satoshis;
        else if (u.token.category === categoryDisplay && !u.token.nft) coins.push({ ...u, owner: a });
      }
    }),
  );
  const failedLookups = settled.filter((r) => r.status === 'rejected').length;
  coins.sort((x, y) => (y.token!.amount === x.token!.amount ? Number(y.satoshis - x.satoshis) : y.token!.amount > x.token!.amount ? 1 : -1));
  return {
    coins,
    pusdUnits: coins.reduce((s, c) => s + c.token!.amount, 0n),
    spendableBchSats: failedLookups ? null : bch,
    failedLookups,
    lookups: addresses.length,
  };
}

/** Largest amount one send can carry: a single coin pays amount + f and keeps at least 1 unit as change (R8). */
export function maxSendUnits(coins: UserCoin[], params: PoolParams): bigint {
  const best = coins.reduce((m, c) => (c.token!.amount > m ? c.token!.amount : m), 0n);
  const max = best - params.feeTokens - 1n;
  return max > 0n ? max : 0n;
}

/** Coins that can carry `amount` (+ f + 1 change unit), most sats first (the least likely to need a top-up). */
export function candidateCoins(coins: UserCoin[], amount: bigint, params: PoolParams, exclude: ReadonlySet<string> = new Set()): UserCoin[] {
  return coins
    .filter((c) => c.token!.amount >= amount + params.feeTokens + 1n && !exclude.has(`${c.txid}:${c.vout}`))
    .sort((a, b) => (b.satoshis === a.satoshis ? 0 : b.satoshis > a.satoshis ? 1 : -1));
}
