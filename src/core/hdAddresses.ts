// Derive the wallet's addresses ourselves from the path xpubs WizardConnect shares in `wallet_ready`
// (the protocol carries no network and no address list). Every shared path is scanned, not only receive/change.
import { decodeHdPublicKey, deriveHdPublicNodeChild, encodeCashAddress, hash160 } from '@bitauth/libauth';

export interface DerivedAddress {
  pathName: string;
  addressIndex: number;
  address: string;
  tokenAddress: string;
}

export const GAP_LIMIT = 20;

export function deriveAddresses(
  paths: { name: string; xpub: string }[],
  count = GAP_LIMIT,
  prefix: 'bitcoincash' | 'bchtest' = 'bitcoincash',
): DerivedAddress[] {
  const out: DerivedAddress[] = [];
  for (const p of paths) {
    const decoded = decodeHdPublicKey(p.xpub);
    if (typeof decoded === 'string') throw new Error(`path ${p.name}: ${decoded}`);
    for (let i = 0; i < count; i++) {
      const child = deriveHdPublicNodeChild(decoded.node, i);
      const pkh = hash160(child.publicKey);
      out.push({
        pathName: p.name,
        addressIndex: i,
        address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
        tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
      });
    }
  }
  return out;
}
