// The two wallet-check shapes on the gate page, signed by a conforming headless signer and run through the same
// verifier the page uses. Mainnet-prefixed addresses, mock provider.
import { describe, expect, it } from 'vitest';
import { encodeCashAddress, hash160, secp256k1, sha256, utf8ToBin } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { shapeA, shapeB } from '../src/gate/shapes';
import { signWcTransaction } from '../src/core/headlessSigner';
import { verifySignedTx, VerifyError } from '../src/core/wizard';
import { lockingBytecodeOf } from '../src/core/dust';
import { PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';

const priv = sha256.hash(utf8ToBin('gate-shape-user'));
const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
const tokenAddress = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: hash160(pub) }).address;
const owner = { tokenAddress, pathName: 'receive', addressIndex: 3 };
const provider = new MockNetworkProvider();
// The gate builds mainnet transactions; the mock is only a stand-in provider, so give it the mainnet prefix.
(provider as { network: string }).network = 'mainnet';
const coin = { ...randomUtxo({ satoshis: 1000n, token: { category: CAT, amount: 150n } }), lockingBytecode: Buffer.from(lockingBytecodeOf(tokenAddress)).toString('hex') };

describe('gate shapes', () => {
  for (const [name, build] of [['(a) covenant input', shapeA], ['(b) merchant input', shapeB]] as const) {
    it(`${name}: a conforming wallet's signature verifies; only input 0 is requested`, () => {
      const shape = build(provider, coin, owner);
      expect(shape.request.inputPaths).toEqual([[0, 'receive', 3]]);
      const hex = signWcTransaction(shape.request.wire, new Map([[0, priv]]));
      const v = verifySignedTx(hex, shape.request.proposed, lockingBytecodeOf(tokenAddress), shape.vmInputs);
      expect(v.sighashType).toBe(0x61);
    });
  }

  it('(b) still refuses a signature from the wrong key', () => {
    const shape = shapeB(provider, coin, owner);
    const hex = signWcTransaction(shape.request.wire, new Map([[0, sha256.hash(utf8ToBin('someone else'))]]));
    expect(() => verifySignedTx(hex, shape.request.proposed, lockingBytecodeOf(tokenAddress), shape.vmInputs)).toThrow(VerifyError);
  });

  it('(b) is why vmInputs exists: full-tx VM verification fails on the placeholder merchant input', () => {
    const shape = shapeB(provider, coin, owner);
    const hex = signWcTransaction(shape.request.wire, new Map([[0, priv]]));
    expect(() => verifySignedTx(hex, shape.request.proposed, lockingBytecodeOf(tokenAddress), 'all')).toThrow(/Input 1|input index 1|validate/);
  });

  it('(a) without a configured lane is flagged as a synthetic pre-check', () => {
    expect(shapeA(provider, coin, owner).synthetic).toBe(true);
    expect(shapeB(provider, coin, owner).synthetic).toBe(true);
  });
});
