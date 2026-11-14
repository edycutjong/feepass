// Measures the real sponsored-send shape from the compiled covenant (no network): redeem script size, tx size,
// miner fee at 1 sat/B, pool subsidy, top-up, dust thresholds. Writes evidence/tx-shape.json.
import { encodeCashAddress, hash160, secp256k1, sha256, utf8ToBin } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { writeFileSync } from 'node:fs';
import { poolContract } from '../src/core/pool';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx } from '../src/core/wizard';
import { dustFor, lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';

const k = (seed: string) => {
  const priv = sha256.hash(utf8ToBin(seed));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  return { priv, pub, addr: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: hash160(pub) }).address };
};
const provider = new MockNetworkProvider();
const owner = k('measure-owner'), user = k('measure-user'), payee = k('measure-payee');
const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: owner.pub, categoryDisplay: CAT }, provider);

const rows = [1000n, 1330n, 2000n, 5000n].map((coinSats) => {
  const userUtxo = provider.addUtxo(user.addr, randomUtxo({ satoshis: coinSats, token: { category: CAT, amount: 200n } }));
  const lane = provider.addUtxo(pool.tokenAddress, randomUtxo({ satoshis: 100_000n, token: { category: CAT, amount: 1n } }));
  const r = buildSponsoredSend({ pool, params: DEFAULT_PARAMS, categoryDisplay: CAT, userUtxo, userAddress: user.addr, lane, recipient: payee.addr, amount: 10n });
  const req = toWizardRequest(r, { pathName: 'receive', addressIndex: 0 });
  const v = verifySignedTx(signWcTransaction(req.wire, new Map([[0, user.priv]])), req.proposed, lockingBytecodeOf(user.addr));
  return { userCoinSats: Number(coinSats), placeholderSizeBytes: r.sizeBytes, signedSizeBytes: v.sizeBytes, minerFeeSats: Number(r.minerFeeSats), topUpSats: Number(r.topUpSats), poolSubsidySats: Number(r.poolSubsidySats), feeRateSatPerByte: Number(v.feeSats) / v.sizeBytes };
});

const userLock = lockingBytecodeOf(user.addr);
const laneLock = lockingBytecodeOf(pool.tokenAddress);
const out = {
  measuredAt: new Date().toISOString(),
  note: 'Computed offline from the compiled artifact; sizes are exact serializations of the signed tx (Schnorr, sighash 0x61).',
  params: { feeTokens: 1, maxSubsidy: Number(DEFAULT_PARAMS.maxSubsidy), maxTopUp: Number(DEFAULT_PARAMS.maxTopUp) },
  redeemScriptBytes: pool.bytesize,
  redeemScriptOpcodes: pool.opcount,
  dust: {
    p2pkhTokenOutput_10units: Number(dustFor(userLock, { category: CAT, amount: 10n })),
    p2pkhTokenOutput_253units: Number(dustFor(userLock, { category: CAT, amount: 253n })),
    laneP2sh32TokenOutput_2units: Number(dustFor(laneLock, { category: CAT, amount: 2n })),
    laneP2sh32TokenOutput_253units: Number(dustFor(laneLock, { category: CAT, amount: 253n })),
  },
  sends: rows,
};
writeFileSync(new URL('../evidence/tx-shape.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
