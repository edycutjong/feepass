// One real sponsored send on MAINNET through the funded pool lane, same code path as the app:
//   1. fund a fresh headless "user" key with one token coin: 1,000 sats + 0.20 PUSD, and no other BCH (from the hot wallet)
//   2. the sponsored send: the user sends 0.10 PUSD to the app's preset recipient; a pool lane pays the miner fee and the
//      covenant takes back exactly 0.01 PUSD; signed by the headless key over the WizardConnect request shape, verified on
//      the BCH VM before broadcast.
// The signer is a headless test key (~/.config/feepass/mainnet-user.env), not a named wallet. Mainnet spends are capped.
// Usage: tsx scripts/mainnet-send.ts --network mainnet --authorized-cap <bch>   (run via specs' wrapper)
import { writeFileSync } from 'node:fs';
import { decodePrivateKeyWif, encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { poolContract } from '../src/core/pool';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx } from '../src/core/wizard';
import { lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';
import config from '../src/config/mainnet.json';
import { readKeyFile } from './env';
import { appendEvidence, hotWallet, network, requireCap } from './lib';

if (network() !== 'mainnet') throw new Error('this script is mainnet only: --network mainnet');
const USER_SATS = 1_000n, USER_UNITS = 20n, SEND_UNITS = 10n, FUND_FEE = 600n;

const d = decodePrivateKeyWif(readKeyFile('mainnet-user').WIF_MAINNET!);
if (typeof d === 'string') throw new Error(d);
const upub = secp256k1.derivePublicKeyCompressed(d.privateKey) as Uint8Array;
const user = {
  priv: d.privateKey,
  address: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(upub) }).address,
  tokenAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: hash160(upub) }).address,
};
const provider = new ElectrumNetworkProvider('mainnet');
const hot = hotWallet('mainnet');
const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: hot.pub, categoryDisplay: CAT }, provider);
if (pool.tokenAddress !== config.tokenAddress) throw new Error(`pool ${pool.tokenAddress} != config ${config.tokenAddress}`);

async function main() {
  // 1. fund the user with one token coin (skipped if it already holds one)
  let userCoins = await provider.getUtxos(user.address);
  if (!userCoins.some((u) => u.token?.category === CAT)) {
    requireCap('mainnet', USER_SATS + FUND_FEE);
    const hotUtxos = await provider.getUtxos(hot.address);
    const tok = hotUtxos.filter((u) => u.token?.category === CAT && !u.token.nft);
    const bch = hotUtxos.filter((u) => !u.token).sort((a, b) => (a.satoshis < b.satoshis ? -1 : 1));
    const units = tok.reduce((s, u) => s + u.token!.amount, 0n);
    if (units < USER_UNITS + 1n) throw new Error(`hot wallet holds ${units} PUSD units`);
    const bchIn = bch.find((u) => u.satoshis > 20_000n)!;
    const tokSats = tok.reduce((s, u) => s + u.satoshis, 0n);
    const signer = new SignatureTemplate(hot.priv);
    const tx = await new TransactionBuilder({ provider })
      .addInputs([...tok, bchIn], signer.unlockP2PKH())
      .addOutput({ to: user.tokenAddress, amount: USER_SATS, token: { category: CAT, amount: USER_UNITS } })
      .addOutput({ to: hot.tokenAddress, amount: tokSats, token: { category: CAT, amount: units - USER_UNITS } })
      .addOutput({ to: hot.address, amount: bchIn.satoshis - USER_SATS - FUND_FEE })
      .send();
    appendEvidence('mainnet', { txid: tx.txid, kind: 'prep', sizeBytes: tx.hex.length / 2, minerFeeSats: FUND_FEE, operatorOutflowSats: USER_SATS + FUND_FEE });
    console.log(`prep  ${tx.txid} (user coin: ${USER_SATS} sats + ${USER_UNITS} PUSD units)`);
    for (let i = 0; i < 20 && !userCoins.some((u) => u.token?.category === CAT); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      userCoins = await provider.getUtxos(user.address);
    }
  }

  // 2. the sponsored send
  const userBch = userCoins.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  const userUtxo = userCoins.find((u) => u.token?.category === CAT)! as SpendableUtxo;
  const lanes = (await provider.getUtxos(pool.address)).filter((u) => u.token?.category === CAT && u.satoshis >= DEFAULT_PARAMS.maxSubsidy + 1_000n);
  if (lanes.length === 0) throw new Error('no open lane');
  const lane = lanes[Math.floor(Math.random() * lanes.length)];
  const send = buildSponsoredSend({ pool, params: DEFAULT_PARAMS, categoryDisplay: CAT, userUtxo, userAddress: user.tokenAddress, lane, recipient: config.demoRecipient, amount: SEND_UNITS });
  const req = toWizardRequest(send, { pathName: 'receive', addressIndex: 0 });
  const signed = signWcTransaction(req.wire, new Map([[0, user.priv]]));
  const v = verifySignedTx(signed, req.proposed, lockingBytecodeOf(user.tokenAddress));
  const txid = await provider.sendRawTransaction(signed);
  if (txid !== v.txid) throw new Error(`txid mismatch ${txid} vs ${v.txid}`);
  await new Promise((r) => setTimeout(r, 2000));
  const after = await provider.getUtxos(user.address);
  const userAfter = after.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  appendEvidence('mainnet', { txid, kind: 'send', sizeBytes: v.sizeBytes, minerFeeSats: v.feeSats, operatorOutflowSats: 0n, poolSubsidySats: send.poolSubsidySats,
    pusdFeeUnits: DEFAULT_PARAMS.feeTokens, userBefore: userBch, userAfter, laneOutpoint: `${lane.txid}:${lane.vout}` });
  const record = {
    network: 'mainnet', recordedAtUtc: new Date().toISOString(), sponsoredTxid: txid, explorer: `https://bchexplorer.info/tx/${txid}`,
    signer: 'headless test key (scripts/mainnet-send.ts), not a named wallet', pool: pool.tokenAddress, lane: `${lane.txid}:${lane.vout}`,
    recipient: config.demoRecipient, sentPusd: '0.10', feePusd: '0.01', sizeBytes: v.sizeBytes, minerFeeSats: Number(v.feeSats),
    poolSubsidySats: Number(send.poolSubsidySats), sighash: '0x' + v.sighashType.toString(16),
    userSpendableBchBefore: Number(userBch), userSpendableBchAfter: Number(userAfter),
    userPusdUnitsAfter: Number(after.reduce((s, u) => s + (u.token?.category === CAT ? u.token.amount : 0n), 0n)),
  };
  writeFileSync(new URL('../evidence/mainnet-send.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
