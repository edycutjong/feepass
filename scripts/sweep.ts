// Operator tool: the covenant's withdraw(ownerSig) path. Collects the pool's PUSD revenue (and BCH) back to the operator
// wallet in ONE transaction, spending every pool UTXO (or only closed lanes with --closed). Re-seed lanes afterwards with
// scripts/split.ts (that is also how lanes are refilled: a lane is topped up by sweeping it and splitting again).
// Usage: tsx scripts/sweep.ts --network mock|chipnet|mainnet [--closed] [--authorized-cap <bch>]
// PUSD is conserved (no burn). The only operator outflow is the miner fee.
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { poolContract } from '../src/core/pool';
import { buildBoard, outpointOf } from '../src/core/lanes';
import { dustFor, lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS, PUSD_CATEGORY_DISPLAY } from '../src/core/params';
import { appendEvidence, arg, hotWallet, network, provider as makeProvider, requireCap } from './lib';

const net = network();
const category = arg('category') ?? PUSD_CATEGORY_DISPLAY;
const onlyClosed = process.argv.includes('--closed');
const provider = makeProvider(net);
const hot = hotWallet(net);
const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: hot.pub, categoryDisplay: category }, provider);

async function main() {
  if (net === 'mock') {
    const m = provider as MockNetworkProvider;
    for (let i = 0; i < 3; i++) m.addUtxo(pool.tokenAddress, randomUtxo({ satoshis: i === 2 ? 900n : 100_000n, token: { category, amount: BigInt(i + 1) } }));
  }
  const all = await provider.getUtxos(pool.tokenAddress);
  const board = buildBoard(all, { categoryDisplay: category, laneLock: lockingBytecodeOf(pool.tokenAddress), params: DEFAULT_PARAMS, n: 1000 });
  const closed = new Set(board.lanes.filter((l) => l.state === 'closed').map((l) => l.outpoint));
  // never touch NFTs or other categories: only PUSD fungibles and plain BCH are swept
  const picked = all.filter((u) => (!u.token || (u.token.category === category && !u.token.nft)) && (!onlyClosed || closed.has(outpointOf(u))));
  if (picked.length === 0) throw new Error(onlyClosed ? 'no closed lanes to sweep' : 'the pool address holds nothing to sweep');
  const units = picked.reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);
  const inSats = picked.reduce((s, u) => s + u.satoshis, 0n);
  const unlocker = pool.unlock.withdraw(new SignatureTemplate(hot.priv));
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider }).addInputs(picked, unlocker);
    b.addOutput({ to: units > 0n ? hot.tokenAddress : hot.address, amount: inSats - fee, ...(units > 0n ? { token: { category, amount: units } } : {}) });
    return b;
  };
  let fee = 0n;
  try {
    for (let k = 0; k < 3; k++) fee = BigInt(build(fee).getTransactionSize()) + 2n;
  } catch {
    throw new Error(`swept value ${inSats} sats is too small to pay the fee and keep the output above dust: sweep more lanes together`);
  }
  const outLock = lockingBytecodeOf(units > 0n ? hot.tokenAddress : hot.address);
  const dust = dustFor(outLock, units > 0n ? { category, amount: units } : undefined);
  if (inSats - fee < dust) throw new Error(`swept value ${inSats} sats cannot pay the fee ${fee} and keep the output above dust ${dust}: sweep more lanes together`);
  requireCap(net, fee);
  const tx = await build(fee).send();
  appendEvidence(net, { txid: tx.txid, kind: 'sweep', sizeBytes: tx.hex.length / 2, minerFeeSats: fee, operatorOutflowSats: fee, pusdFeeUnits: units });
  console.log(JSON.stringify({ network: net, txid: tx.txid, inputs: picked.length, pusdUnits: Number(units), sats: Number(inSats - fee), feeSats: Number(fee), closedOnly: onlyClosed }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
