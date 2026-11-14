import { describe, expect, it } from 'vitest';
import { binToHex, decodeTransaction, encodeTransaction, hexToBin, type TransactionCommon } from '@bitauth/libauth';
import { buildSponsoredSend, ECDSA_SLACK_BYTES, isUsableLane, SendError } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx, VerifyError } from '../src/core/wizard';
import { categoryToInternalOrder, DEFAULT_PARAMS, feeCoversSubsidy, PUSD_CATEGORY_DISPLAY } from '../src/core/params';
import { lockingBytecodeOf } from '../src/core/dust';
import { setup, pusd, key, CAT, FOREIGN } from './helpers';
import { encodeCashAddress } from '@bitauth/libauth';

function send(s: ReturnType<typeof setup>, o: Partial<Parameters<typeof buildSponsoredSend>[0]> = {}) {
  return buildSponsoredSend({
    pool: s.pool, params: s.params, categoryDisplay: CAT,
    userUtxo: o.userUtxo ?? s.addUserCoin(100n, 1000n), userAddress: s.user.tokenAddress,
    lane: o.lane ?? s.addLane(), recipient: o.recipient ?? s.payee.tokenAddress, amount: o.amount ?? 10n, ...o,
  });
}

describe('buildSponsoredSend', () => {
  it('produces the fixed 2-in/3-out shape with the fee from the serialized size (≥ 1 sat/B)', () => {
    const s = setup();
    const r = send(s);
    expect(r.builder.inputs).toHaveLength(2);
    expect(r.builder.outputs).toHaveLength(3);
    expect(r.minerFeeSats).toBe(BigInt(r.sizeBytes + ECDSA_SLACK_BYTES));
    expect(r.poolSubsidySats).toBeLessThanOrEqual(DEFAULT_PARAMS.maxSubsidy);
    expect(r.outputs.laneUnits).toBe(2n); // seed 1 + f 1
    expect(r.outputs.changeUnits).toBe(89n);
  });

  it('a 1,000-sat coin needs a top-up within T; a coin with ≥ 2 dusts needs none', () => {
    const s = setup();
    const small = send(s);
    expect(small.topUpSats).toBeGreaterThan(0n);
    expect(small.topUpSats).toBeLessThanOrEqual(DEFAULT_PARAMS.maxTopUp);
    const big = send(s, { userUtxo: s.addUserCoin(100n, 5000n) });
    expect(big.topUpSats).toBe(0n);
    expect(big.outputs.recipientSats + big.outputs.changeSats).toBe(5000n);
  });

  it('refuses a coin whose two token dusts would need more than T', () => {
    const s = setup();
    expect(() => send(s, { userUtxo: s.addUserCoin(100n, 600n) })).toThrow(expect.objectContaining({ code: 'TOPUP_EXCEEDS_CAP' }));
  });

  it('needs amount + f + 1 unit (change must stay a PUSD output, R8)', () => {
    const s = setup();
    expect(() => send(s, { userUtxo: s.addUserCoin(11n), amount: 10n })).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_PUSD' }));
    expect(() => send(s, { userUtxo: s.addUserCoin(12n), amount: 10n })).not.toThrow();
  });

  it('refuses non-PUSD coins, NFT coins, zero amounts, token-less lanes and P2SH recipients', () => {
    const s = setup();
    const codes = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as SendError).code; } };
    expect(codes(() => send(s, { userUtxo: s.addUserCoin(0n, 1000n, { category: FOREIGN, amount: 100n }) }))).toBe('NOT_PUSD');
    expect(codes(() => send(s, { userUtxo: s.addUserCoin(0n, 1000n, { category: CAT, amount: 100n, nft: { capability: 'none', commitment: '' } }) }))).toBe('NFT_COIN');
    expect(codes(() => send(s, { amount: 0n }))).toBe('BAD_AMOUNT');
    expect(codes(() => send(s, { lane: s.addLane(100_000n, 0n, null) }))).toBe('LANE_NOT_PUSD');
    const p2sh = encodeCashAddress({ prefix: 'bchtest', type: 'p2shWithTokens', payload: new Uint8Array(32) }).address;
    expect(codes(() => send(s, { recipient: p2sh }))).toBe('P2SH_RECIPIENT');
  });

  it('refuses a lane that cannot keep its own dust, and a subsidy above C', () => {
    const s = setup();
    const codes = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as SendError).code; } };
    expect(codes(() => send(s, { lane: s.addLane(1_200n) }))).toBe('LANE_TOO_SMALL');
    expect(codes(() => send(s, { params: { ...DEFAULT_PARAMS, maxSubsidy: 800n } }))).toBe('SUBSIDY_EXCEEDS_CAP');
  });

  it('isUsableLane: needs PUSD, no NFT, and value ≥ C + its own token dust', () => {
    const s = setup();
    const lock = lockingBytecodeOf(s.pool.tokenAddress);
    expect(isUsableLane(s.addLane(100_000n), CAT, s.params, lock)).toBe(true);
    expect(isUsableLane(s.addLane(2_600n), CAT, s.params, lock)).toBe(false);
    expect(isUsableLane(s.addLane(100_000n, 0n, null), CAT, s.params, lock)).toBe(false);
  });
});

describe('verifySignedTx (what the wallet returns)', () => {
  function signed(s: ReturnType<typeof setup>, sighash?: number, signer = s.user.priv) {
    const r = send(s);
    const req = toWizardRequest(r, { pathName: 'receive', addressIndex: 0 });
    return { req, hex: signWcTransaction(req.wire, new Map([[0, signer]]), sighash) };
  }
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as VerifyError).code; } };

  it('accepts an unchanged tx signed 0x61 by the coin owner', () => {
    const s = setup(); const { req, hex } = signed(s);
    expect(code(() => verifySignedTx(hex, req.proposed, s.user.lock))).toBe('ok');
  });
  it('refuses hex that is not whole bytes (a trailing nibble, a non-hex pair) and returns exactly the bytes it verified', () => {
    const s = setup(); const { req, hex } = signed(s);
    expect(code(() => verifySignedTx(hex + 'a', req.proposed, s.user.lock))).toBe('DECODE');
    expect(code(() => verifySignedTx(hex.slice(0, -2) + 'zz', req.proposed, s.user.lock))).toBe('DECODE');
    expect(code(() => verifySignedTx('', req.proposed, s.user.lock))).toBe('DECODE');
    expect(verifySignedTx(hex.toUpperCase(), req.proposed, s.user.lock).hex).toBe(hex.toLowerCase());
  });
  it('refuses sighash 0x41 (ALL|FORKID without UTXOS)', () => {
    const s = setup(); const { req, hex } = signed(s, 0x41);
    expect(code(() => verifySignedTx(hex, req.proposed, s.user.lock))).toBe('SIGHASH');
  });
  it('refuses a signature by a different key', () => {
    const s = setup(); const { req, hex } = signed(s, undefined, key('someone').priv);
    expect(code(() => verifySignedTx(hex, req.proposed, s.user.lock))).toBe('SIGNER');
  });
  const mutate = (hex: string, f: (t: TransactionCommon) => void) => {
    const tx = decodeTransaction(hexToBin(hex)) as TransactionCommon; f(tx); return binToHex(encodeTransaction(tx));
  };
  it('refuses a changed input sequence, version, locktime, pool unlock or output count', () => {
    const s = setup(); const { req, hex } = signed(s);
    const v = (h: string) => code(() => verifySignedTx(h, req.proposed, s.user.lock));
    expect(v(mutate(hex, (t) => { t.inputs[0] = { ...t.inputs[0]!, sequenceNumber: 0 }; }))).toBe('INPUTS');
    expect(v(mutate(hex, (t) => { t.version = 1; }))).toBe('OUTPUTS');
    expect(v(mutate(hex, (t) => { t.locktime = 900_000; }))).toBe('OUTPUTS');
    expect(v(mutate(hex, (t) => { t.inputs[1] = { ...t.inputs[1]!, unlockingBytecode: Uint8Array.of(...t.inputs[1]!.unlockingBytecode, 0x51) }; }))).toBe('POOL_UNLOCK');
    expect(v(mutate(hex, (t) => { t.outputs.pop(); }))).toBe('SHAPE');
  });
  it('refuses a garbage signature that carries the right public key and sighash byte (VM check)', () => {
    const s = setup(); const { req, hex } = signed(s);
    const forged = mutate(hex, (t) => {
      const u = t.inputs[0]!.unlockingBytecode;
      const sig = Uint8Array.of(...new Uint8Array(64).fill(7), 0x61);
      t.inputs[0] = { ...t.inputs[0]!, unlockingBytecode: Uint8Array.of(65, ...sig, ...u.slice(1 + 65)) };
    });
    expect(code(() => verifySignedTx(forged, req.proposed, s.user.lock))).toBe('SCRIPT');
  });
  it('refuses a result whose fee falls below 1 sat/B (source values lower than proposed)', () => {
    const s = setup(); const { req, hex } = signed(s);
    const lowered = { ...req.proposed, sourceOutputs: req.proposed.sourceOutputs.map((o, i) => (i === 1 ? { ...o, valueSatoshis: o.valueSatoshis - 300n } : o)) };
    expect(code(() => verifySignedTx(hex, lowered, s.user.lock))).toBe('FEE');
  });
  it('refuses bytes that do not decode as a transaction', () => {
    const s = setup(); const { req } = signed(s);
    expect(code(() => verifySignedTx('00ff', req.proposed, s.user.lock))).toBe('DECODE');
  });
  it('refuses a wallet that redirected an output', () => {
    const s = setup(); const { req, hex } = signed(s);
    const tx = decodeTransaction(hexToBin(hex)) as TransactionCommon;
    tx.outputs[0] = { ...tx.outputs[0]!, lockingBytecode: key('thief').lock };
    expect(code(() => verifySignedTx(binToHex(encodeTransaction(tx)), req.proposed, s.user.lock))).toBe('OUTPUTS');
  });
});

describe('params', () => {
  it('stores the PUSD category in internal (reversed) byte order', () => {
    const internal = categoryToInternalOrder(PUSD_CATEGORY_DISPLAY);
    expect(internal.slice(0, 2)).toBe('44');
    expect(categoryToInternalOrder(internal)).toBe(PUSD_CATEGORY_DISPLAY);
  });
  it('f = 1 unit covers 1.5 × C = 2,000 sats up to BCH $333, not at $334', () => {
    expect(feeCoversSubsidy(DEFAULT_PARAMS, 333)).toBe(true);
    expect(feeCoversSubsidy(DEFAULT_PARAMS, 334)).toBe(false);
  });
  it('T ≤ one token-P2PKH dust and T + measured fee ≤ C', () => {
    const s = setup();
    const r = send(s);
    expect(DEFAULT_PARAMS.maxTopUp).toBeLessThan(DEFAULT_PARAMS.maxSubsidy);
    expect(r.minerFeeSats + DEFAULT_PARAMS.maxTopUp).toBeLessThanOrEqual(DEFAULT_PARAMS.maxSubsidy);
  });
});
void pusd;
