import { describe, expect, it } from 'vitest';
import {
  deriveHdPath, deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeCashAddress,
  encodeHdPublicKey, hash160, hexToBin, secp256k1, type HdPrivateNodeValid,
} from '@bitauth/libauth';
import { deriveAddresses } from '../src/core/hdAddresses';

describe('deriveAddresses', () => {
  it('derives index i of each shared path xpub to the same address as the private key path', () => {
    const master = deriveHdPrivateNodeFromSeed(hexToBin('000102030405060708090a0b0c0d0e0f'), { throwErrors: true }) as HdPrivateNodeValid;
    const recv = deriveHdPath(master, "m/44'/145'/0'/0") as HdPrivateNodeValid;
    const xpub = encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(recv) }).hdPublicKey;
    const list = deriveAddresses([{ name: 'receive', xpub }, { name: 'defi', xpub }], 3);
    expect(list).toHaveLength(6);
    const child2 = deriveHdPrivateNodeChild(recv, 2) as HdPrivateNodeValid;
    const pub = secp256k1.derivePublicKeyCompressed(child2.privateKey) as Uint8Array;
    const want = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: hash160(pub) }).address;
    expect(list[2]).toMatchObject({ pathName: 'receive', addressIndex: 2, tokenAddress: want });
    expect(list[5]!.pathName).toBe('defi');
  });
});
