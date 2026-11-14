// Splits the hot wallet into N pool lanes in ONE tx: N outputs of S sats + 1 PUSD unit each (R7 seed) to the covenant's
// token address, a PUSD change output and a BCH change output back to the hot wallet. Sum of PUSD out = sum in (no burn).
// Usage: tsx scripts/split.ts --network mock|chipnet|mainnet --lanes N --sats S [--category <display hex>]
//        [--authorized-cap <bch>] [--gate]   (--gate writes lane 0 into src/config/gate.json for the wallet check)
import { readFileSync, writeFileSync } from 'node:fs';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { poolContract } from '../src/core/pool';
import { DEFAULT_PARAMS, LANE_SEED_UNITS, PUSD_CATEGORY_DISPLAY } from '../src/core/params';
import { appendEvidence, arg, hotWallet, network, provider as makeProvider, requireCap } from './lib';

const net = network();
const lanes = Number(arg('lanes'));
const sats = BigInt(arg('sats') ?? '100000');
const category = arg('category') ?? PUSD_CATEGORY_DISPLAY;
if (!Number.isInteger(lanes) || lanes < 1 || lanes > 50) throw new Error('--lanes 1..50');
if (sats < 10_000n) throw new Error('--sats must be at least 10,000');

const provider = makeProvider(net);
const hot = hotWallet(net);
const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: hot.pub, categoryDisplay: category }, provider);

async function main() {
  if (net === 'mock') {
    const m = provider as MockNetworkProvider;
    m.addUtxo(hot.address, randomUtxo({ satoshis: BigInt(lanes) * sats + 50_000n }));
    m.addUtxo(hot.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category, amount: 50n } }));
  }
  const utxos = await provider.getUtxos(hot.address);
  const bch = utxos.filter((u) => !u.token);
  const pusd = utxos.filter((u) => u.token?.category === category && !u.token.nft);
  const pusdUnits = pusd.reduce((s, u) => s + u.token!.amount, 0n);
  const need = BigInt(lanes) * LANE_SEED_UNITS;
  if (pusdUnits < need) throw new Error(`hot wallet holds ${pusdUnits} PUSD units; ${lanes} lanes need ${need} (no token-less lanes, R7)`);
  if (bch.length === 0) throw new Error(`hot wallet ${hot.address} holds no plain BCH`);

  const inSats = [...bch, ...pusd].reduce((s, u) => s + u.satoshis, 0n);
  const signer = new SignatureTemplate(hot.priv).unlockP2PKH();
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider }).addInputs(bch, signer).addInputs(pusd, signer);
    for (let i = 0; i < lanes; i++) b.addOutput({ to: pool.tokenAddress, amount: sats, token: { category, amount: LANE_SEED_UNITS } });
    b.addOutput({ to: hot.tokenAddress, amount: 1000n, token: { category, amount: pusdUnits - need } });
    const change = inSats - BigInt(lanes) * sats - 1000n - fee;
    if (change < 546n) throw new Error(`not enough BCH: short by ${546n - change} sats`);
    b.addOutput({ to: hot.address, amount: change });
    return b;
  };
  let fee = 1000n;
  for (let k = 0; k < 3; k++) fee = BigInt(build(fee).getTransactionSize()) + 2n;
  const outflow = BigInt(lanes) * sats + fee;
  requireCap(net, outflow);

  const tx = await build(fee).send();
  const laneOutpoints = Array.from({ length: lanes }, (_, i) => `${tx.txid}:${i}`);
  appendEvidence(net, { txid: tx.txid, kind: 'split', sizeBytes: tx.hex.length / 2, minerFeeSats: fee, operatorOutflowSats: outflow, laneOutpoint: laneOutpoints[0] });
  console.log(JSON.stringify({ network: net, txid: tx.txid, lanes, satsPerLane: Number(sats), feeSats: Number(fee), pool: pool.tokenAddress }, null, 2));

  if (process.argv.includes('--gate') && net === 'mainnet') {
    const gatePath = new URL('../src/config/gate.json', import.meta.url);
    const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    gate.lane = { txid: tx.txid, vout: 0, satoshis: String(sats), units: String(LANE_SEED_UNITS) };
    writeFileSync(gatePath, JSON.stringify(gate, null, 2) + '\n');
    console.log('gate.json lane set; rebuild and redeploy the gate page');
  }
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
