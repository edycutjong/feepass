import { encodeCashAddress, hash160, secp256k1, sha256, utf8ToBin, binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type SpendableUtxo, type TokenDetails } from 'cashscript';
import { poolContract } from '../src/core/pool';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY, type PoolParams } from '../src/core/params';
import { lockingBytecodeOf } from '../src/core/dust';

export const CAT = PUSD_CATEGORY_DISPLAY;
export const FOREIGN = 'ab'.repeat(32);

export function key(seed: string) {
  const priv = sha256.hash(utf8ToBin(seed));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const prefix = 'bchtest' as const;
  const address = encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(pub) }).address;
  const tokenAddress = encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: hash160(pub) }).address;
  return { priv, pub, pubHex: binToHex(pub), address, tokenAddress, lock: lockingBytecodeOf(tokenAddress) };
}

export function pusd(amount: bigint): TokenDetails {
  return { category: CAT, amount };
}

export function setup(params: PoolParams = DEFAULT_PARAMS) {
  const provider = new MockNetworkProvider();
  const owner = key('owner');
  const user = key('user');
  const payee = key('payee');
  const pool = poolContract({ ...params, ownerPk: owner.pub, categoryDisplay: CAT }, provider);
  const addLane = (sats = 100_000n, units = 1n, token: TokenDetails | null = pusd(units)): SpendableUtxo =>
    provider.addUtxo(pool.tokenAddress, randomUtxo({ satoshis: sats, token: token ?? undefined }));
  const addUserCoin = (units: bigint, sats = 1000n, token: TokenDetails | null = pusd(units)): SpendableUtxo =>
    provider.addUtxo(user.tokenAddress, randomUtxo({ satoshis: sats, token: token ?? undefined }));
  return { provider, owner, user, payee, pool, params, addLane, addUserCoin };
}
