// Shared helpers for operator scripts: network/provider selection, hot-wallet key, cap guard, evidence CSV.
import { decodePrivateKeyWif, encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, MockNetworkProvider, type NetworkProvider } from 'cashscript';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readKeyFile } from './env';

export type Net = 'mock' | 'chipnet' | 'mainnet';

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function network(): Net {
  const n = arg('network');
  if (n !== 'mock' && n !== 'chipnet' && n !== 'mainnet') throw new Error('--network mock|chipnet|mainnet');
  return n;
}

export function provider(net: Net): NetworkProvider {
  return net === 'mock' ? new MockNetworkProvider() : new ElectrumNetworkProvider(net);
}

export const prefixOf = (net: Net) => (net === 'mainnet' ? 'bitcoincash' : 'bchtest') as 'bitcoincash' | 'bchtest';

export function hotWallet(net: Net) {
  const env = readKeyFile('hot-wallet');
  const d = decodePrivateKeyWif(net === 'mainnet' ? env.WIF_MAINNET! : env.WIF_TESTNET!);
  if (typeof d === 'string') throw new Error(d);
  const pub = secp256k1.derivePublicKeyCompressed(d.privateKey) as Uint8Array;
  const pkh = hash160(pub);
  const prefix = prefixOf(net);
  return {
    priv: d.privateKey,
    pub,
    address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
  };
}

const CSV_HEADER =
  'txid,kind,first_seen_utc,block_height,size_bytes,miner_fee_sats,pool_subsidy_sats,pusd_fee_units,user_spendable_before_sats,user_spendable_after_sats,lane_outpoint,running_total_sats,external\n';
const csvPath = (net: Net) => new URL(`../evidence/${net}-txs.csv`, import.meta.url);

/** Sats that have left the operator's hot wallet so far on this network (the last running_total). */
export function spentSoFar(net: Net): bigint {
  if (!existsSync(csvPath(net))) return 0n;
  const rows = readFileSync(csvPath(net), 'utf8').trim().split('\n').slice(1);
  const last = rows.at(-1)?.split(',')[11];
  return last ? BigInt(last) : 0n;
}

export interface EvidenceRow {
  txid: string;
  kind: 'split' | 'send' | 'starter' | 'sweep' | 'genesis';
  sizeBytes: number;
  minerFeeSats: bigint;
  poolSubsidySats?: bigint;
  pusdFeeUnits?: bigint;
  userBefore?: bigint;
  userAfter?: bigint;
  laneOutpoint?: string;
  /** sats this tx moved out of the operator's control (fees + lane funding); 0 for user sends */
  operatorOutflowSats: bigint;
  external?: boolean;
}

/** Mock runs never write evidence: mock txids prove nothing on chain. */
export function appendEvidence(net: Net, r: EvidenceRow): void {
  if (net === 'mock') return;
  if (!existsSync(csvPath(net))) writeFileSync(csvPath(net), CSV_HEADER);
  const total = spentSoFar(net) + r.operatorOutflowSats;
  const v = (x?: bigint | boolean | string) => (x === undefined ? '' : String(x));
  const row = [r.txid, r.kind, new Date().toISOString(), '', r.sizeBytes, r.minerFeeSats, v(r.poolSubsidySats), v(r.pusdFeeUnits),
    v(r.userBefore), v(r.userAfter), v(r.laneOutpoint), total, v(r.external ?? false)];
  appendFileSync(csvPath(net), row.join(',') + '\n');
}

/** Mainnet spends need an explicit cap; the scripts never read the kitchen authorization file themselves. */
export function requireCap(net: Net, outflowSats: bigint): void {
  if (net !== 'mainnet') return;
  const cap = arg('authorized-cap');
  if (!cap) throw new Error('mainnet refuses without --authorized-cap <bch>');
  const capSats = BigInt(Math.round(Number(cap) * 1e8));
  const after = spentSoFar(net) + outflowSats;
  if (after > capSats) throw new Error(`cap exceeded: ${after} sats would leave the hot wallet, cap is ${capSats}`);
}
