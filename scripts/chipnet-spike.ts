// End-to-end spike of the sponsored send on a real network (chipnet) or the mock VM, same code path:
//   1. (if needed) self-send to get a vout-0 coin, the only kind that can mint a token category
//   2. genesis tx: mint a test fungible token standing in for PUSD; in the same tx seed one pool lane
//      (100,000 sats + 1 unit, R7) and give a fresh "user" key a 1,000-sat coin holding 200 units and no other BCH
//   3. the sponsored send: user sends 10 units, the covenant pays the miner fee, the user pays 1 unit to the pool
// Every broadcast tx is appended to evidence/<network>-txs.csv (chipnet only; mock writes nothing).
// Usage: tsx scripts/chipnet-spike.ts --network mock|chipnet
import { decodePrivateKeyWif, encodePrivateKeyWif, generatePrivateKey, hash160, secp256k1, encodeCashAddress } from '@bitauth/libauth';
import {
  ElectrumNetworkProvider, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo,
  type NetworkProvider, type SpendableUtxo,
} from 'cashscript';
import { poolContract } from '../src/core/pool';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx } from '../src/core/wizard';
import { lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS } from '../src/core/params';
import { readKeyFile } from './env';
import { appendEvidence } from './lib';

const network = process.argv[process.argv.indexOf('--network') + 1];
if (network !== 'mock' && network !== 'chipnet') throw new Error('--network mock|chipnet');

const LANE_SATS = 100_000n, USER_SATS = 1_000n, SUPPLY = 1_000_000n, USER_UNITS = 200n;

function keyFromWif(wif: string) {
  const d = decodePrivateKeyWif(wif);
  if (typeof d === 'string') throw new Error(d);
  const pub = secp256k1.derivePublicKeyCompressed(d.privateKey) as Uint8Array;
  const pkh = hash160(pub);
  return {
    priv: d.privateKey, pub,
    address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address,
  };
}

const hot = keyFromWif(readKeyFile('hot-wallet').WIF_TESTNET!);
// mock: a throwaway key; chipnet: ~/.config/feepass/chipnet-user.env (tsx scripts/keygen.ts chipnet-user)
const user = network === 'mock'
  ? keyFromWif(encodePrivateKeyWif(generatePrivateKey(), 'testnet'))
  : keyFromWif(readKeyFile('chipnet-user').WIF_TESTNET!);
const provider: NetworkProvider = network === 'mock' ? new MockNetworkProvider() : new ElectrumNetworkProvider('chipnet');
// Evidence rows use the shared 13-column schema (scripts/lib.ts); mock runs write nothing.
const log = (txid: string, kind: 'prep' | 'genesis' | 'send', size: number, fee: bigint, outflow: bigint, extra: { subsidy?: bigint; feeTokens?: bigint; before?: bigint; after?: bigint; lane?: string } = {}) => {
  appendEvidence(network, { txid, kind, sizeBytes: size, minerFeeSats: fee, operatorOutflowSats: outflow, poolSubsidySats: extra.subsidy, pusdFeeUnits: extra.feeTokens, userBefore: extra.before, userAfter: extra.after, laneOutpoint: extra.lane });
  console.log(`${kind.padEnd(10)} ${txid} ${size} B fee ${fee}`);
};

async function main() {
  if (network === 'mock') (provider as MockNetworkProvider).addUtxo(hot.address, randomUtxo({ satoshis: 500_000n, vout: 0 }));
  const signer = new SignatureTemplate(hot.priv);
  let funds = (await provider.getUtxos(hot.address)).filter((u) => !u.token);
  if (funds.length === 0) throw new Error(`hot wallet ${hot.address} holds no ${network} BCH; fund it first`);
  const total = funds.reduce((s, u) => s + u.satoshis, 0n);

  // 1. ensure a vout-0 coin
  let genesisCoin = funds.find((u) => u.vout === 0 && u.satoshis > LANE_SATS + 20_000n);
  if (!genesisCoin) {
    const b = new TransactionBuilder({ provider }).addInputs(funds, signer.unlockP2PKH())
      .addOutput({ to: hot.address, amount: total - 500n });
    const tx = await b.send();
    log(tx.txid, 'prep', tx.hex.length / 2, 500n, 500n);
    genesisCoin = (await provider.getUtxos(hot.address)).find((u) => u.txid === tx.txid && u.vout === 0)!;
  }

  // 2. genesis + lane seed + user coin in one tx
  const category = genesisCoin.txid;
  const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: hot.pub, categoryDisplay: category }, provider);
  const fee = 1_000n;
  const change = genesisCoin.satoshis - LANE_SATS - USER_SATS - 1_000n - fee;
  const g = await new TransactionBuilder({ provider }).addInput(genesisCoin, signer.unlockP2PKH())
    .addOutput({ to: pool.tokenAddress, amount: LANE_SATS, token: { category, amount: 1n } })
    .addOutput({ to: user.tokenAddress, amount: USER_SATS, token: { category, amount: USER_UNITS } })
    .addOutput({ to: hot.tokenAddress, amount: 1_000n, token: { category, amount: SUPPLY - 1n - USER_UNITS } })
    .addOutput({ to: hot.address, amount: change })
    .send();
  log(g.txid, 'genesis', g.hex.length / 2, fee, fee + LANE_SATS + USER_SATS, { lane: `${g.txid}:0` });

  // 3. the sponsored send, from a wallet whose only coin is a token coin
  const userCoins = await provider.getUtxos(user.address);
  const userBch = userCoins.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  const userUtxo = userCoins.find((u) => u.token?.category === category)! as SpendableUtxo;
  const lane = (await provider.getUtxos(pool.address)).find((u) => u.token?.category === category)!;
  const send = buildSponsoredSend({ pool, params: DEFAULT_PARAMS, categoryDisplay: category, userUtxo, userAddress: user.tokenAddress, lane, recipient: hot.tokenAddress, amount: 10n });
  const req = toWizardRequest(send, { pathName: 'receive', addressIndex: 0 });
  const signed = signWcTransaction(req.wire, new Map([[0, user.priv]]));
  const v = verifySignedTx(signed, req.proposed, lockingBytecodeOf(user.tokenAddress));
  const txid = await provider.sendRawTransaction(signed);
  if (txid !== v.txid) throw new Error(`txid mismatch ${txid} vs ${v.txid}`);
  const userAfter = (await provider.getUtxos(user.address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  log(txid, 'send', v.sizeBytes, v.feeSats, 0n, { subsidy: send.poolSubsidySats, feeTokens: DEFAULT_PARAMS.feeTokens, before: userBch, after: userAfter });

  const after = await provider.getUtxos(user.address);
  console.log(JSON.stringify({
    network, category, pool: pool.tokenAddress, user: user.tokenAddress,
    userSpendableBchBefore: Number(userBch),
    userSpendableBchAfter: Number(after.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n)),
    userUnitsAfter: Number(after.reduce((s, u) => s + (u.token?.category === category ? u.token.amount : 0n), 0n)),
    laneAfter: (await provider.getUtxos(pool.address)).map((u) => ({ sats: Number(u.satoshis), units: Number(u.token?.amount ?? 0n) })),
    sighash: '0x' + v.sighashType.toString(16), sponsoredTxid: txid,
  }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
