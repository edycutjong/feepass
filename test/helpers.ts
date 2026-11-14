import { encodeCashAddress, encodeTransaction, hash160, hexToBin, secp256k1, sha256, utf8ToBin, binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type SpendableUtxo, type TokenDetails, type Utxo } from 'cashscript';
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

/** A stand-in for the tx that created `utxo`: it pays `lock` at `utxo.vout`, so prevout checks can read it from a mock. */
export function fundingTxHex(utxo: { vout: number }, lock: Uint8Array): string {
  return binToHex(encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [{ outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: Array.from({ length: utxo.vout + 1 }, (_, k) => ({ lockingBytecode: k === utxo.vout ? lock : Uint8Array.of(0x6a), valueSatoshis: 0n })),
  }));
}

/** MockNetworkProvider that also serves a funding tx for every coin added with addUtxo (the faucet's prevout check). */
export class FundedMock extends MockNetworkProvider {
  funding = new Map<string, string>();
  addUtxo(addressOrLockingBytecode: string, utxo: Utxo): SpendableUtxo {
    const added = super.addUtxo(addressOrLockingBytecode, utxo);
    const lock = /^[0-9a-f]+$/i.test(addressOrLockingBytecode) ? hexToBin(addressOrLockingBytecode) : lockingBytecodeOf(addressOrLockingBytecode);
    this.funding.set(added.txid, fundingTxHex(added, lock));
    return added;
  }
  async getRawTransaction(txid: string): Promise<string> {
    // a real (broadcast) tx first: the mock's own broadcast path also calls addUtxo for the outputs it creates
    const real = await super.getRawTransaction(txid).catch(() => undefined);
    return (real ?? this.funding.get(txid)) as string;
  }
}
