import { cashAddressToLockingBytecode, getDustThreshold, hexToBin } from '@bitauth/libauth';
import type { TokenDetails } from 'cashscript';

export function lockingBytecodeOf(address: string): Uint8Array {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`invalid cashaddr ${address}: ${r}`);
  return r.bytecode;
}

/** Network dust threshold for an output, computed from its serialized size (token prefix included). */
export function dustFor(lockingBytecode: Uint8Array, token?: TokenDetails): bigint {
  return getDustThreshold({
    lockingBytecode,
    valueSatoshis: 0n,
    token: token
      ? {
          amount: token.amount,
          category: hexToBin(token.category),
          nft: token.nft ? { capability: token.nft.capability, commitment: hexToBin(token.nft.commitment) } : undefined,
        }
      : undefined,
  });
}
