// Starter PUSD: the faucet claim a judge with no PUSD uses to make their first send. Pure logic over an injected chain
// reader, so the one serverless function (api/feepass.ts) stays thin and every rule here is unit-tested offline.
//
// Real guarantees (stated in the UI and README, never more): one claim per receiving address and a daily claim cap, both
// counted from the faucet address's own on-chain history (stateless, no database), and a hard budget = what the faucet
// holds. The history read is NOT atomic: two requests inside about a minute can both pass, bounded by the claim size.
import {
  binToHex,
  decodeTransaction,
  hexToBin,
  type Transaction,
} from '@bitauth/libauth';
import { SignatureTemplate, TransactionBuilder, type NetworkProvider, type SpendableUtxo } from 'cashscript';
import { dustFor, lockingBytecodeOf } from './dust';
import { parseRecipient } from './amounts';

/** What the claim logic needs from the chain. `history` includes the mempool (Fulcrum `get_history`). */
export interface FaucetChain extends NetworkProvider {
  history(address: string): Promise<{ txid: string; height: number }[]>;
  tipHeight(): Promise<number>;
  /** Unix seconds of the block header at `height`. */
  blockTime(height: number): Promise<number>;
}

export interface StarterConfig {
  category: string; // display order
  /** Faucet key: the P2PKH identity that holds the starter PUSD. */
  faucetPriv: Uint8Array;
  faucetPub: Uint8Array;
  faucetAddress: string; // plain q… form (BCH inputs)
  faucetTokenAddress: string; // z… form (token coins)
  /** Base units per claim (0.25 PUSD = 25). */
  claimUnits: bigint;
  /** Public claims per UTC day. */
  dailyCap: number;
  /** Sats on the starter output. Must be ≥ 2 × the token dust so the first send needs no top-up (asserted). */
  starterSats: bigint;
  feeRate?: number;
  now?: () => number; // ms
  rng?: () => number;
}

export class StarterError extends Error {
  constructor(
    public code: 'BAD_ADDRESS' | 'SELF' | 'ALREADY_CLAIMED' | 'DAILY_CAP' | 'FAUCET_EMPTY' | 'FAUCET_NO_BCH' | 'BUSY' | 'DUST' | 'CHAIN',
    message: string,
  ) {
    super(message);
    this.name = 'StarterError';
  }
}

export const STARTER_DEFAULTS = { claimUnits: 25n, dailyCap: 3, starterSats: 1400n } as const;

const HISTORY_FETCH_LIMIT = 300;
/** Blocks to look back when fetching header times for the UTC-day cap: > 1 day even when blocks are slow. */
const DAY_LOOKBACK_BLOCKS = 300;

/** Spent-coin test without a prevout lookup: a P2PKH unlock ends with the signer's pubkey push. */
function spendsFaucetCoin(tx: Transaction, pubHex: string): boolean {
  return tx.inputs.some((i) => binToHex(i.unlockingBytecode).endsWith('21' + pubHex));
}

export interface ClaimHistory {
  /** Receiving locking bytecodes (hex) of every earlier claim. */
  claimedLocks: Set<string>;
  claimsToday: number;
  claimCount: number;
  historyTruncated: boolean;
}

/**
 * Reads the faucet's own history. A claim is a transaction that SPENDS a faucet coin; inbound sends (judges returning PUSD
 * to the faucet, the form's preset recipient) never count, in the daily cap or in the per-address check.
 */
export async function readClaimHistory(chain: FaucetChain, c: StarterConfig): Promise<ClaimHistory> {
  const nowMs = (c.now ?? Date.now)();
  const dayStart = Math.floor(nowMs / 86_400_000) * 86_400;
  const pubHex = binToHex(c.faucetPub);
  const faucetLock = binToHex(lockingBytecodeOf(c.faucetTokenAddress));
  const all = await chain.history(c.faucetAddress).catch(() => { throw new StarterError('CHAIN', 'Could not read the faucet history.'); });
  const tokenAll = await chain.history(c.faucetTokenAddress).catch(() => all);
  // the p2pkh and token-aware addresses share one locking script, so one history; merge defensively and de-duplicate
  const entries = [...new Map([...all, ...tokenAll].map((e) => [e.txid, e])).values()];
  const truncated = entries.length > HISTORY_FETCH_LIMIT;
  const recent = entries.slice(-HISTORY_FETCH_LIMIT);
  const tip = recent.some((e) => e.height > 0) ? await chain.tipHeight().catch(() => 0) : 0;
  const timeCache = new Map<number, number>();
  const timeOf = async (height: number): Promise<number> => {
    if (height <= 0) return Math.floor(nowMs / 1000); // mempool
    if (tip && height < tip - DAY_LOOKBACK_BLOCKS) return 0; // older than a day
    if (!timeCache.has(height)) timeCache.set(height, await chain.blockTime(height));
    return timeCache.get(height)!;
  };

  const claimedLocks = new Set<string>();
  let claimsToday = 0;
  let claimCount = 0;
  const limit = 6;
  for (let i = 0; i < recent.length; i += limit) {
    await Promise.all(
      recent.slice(i, i + limit).map(async (e) => {
        const tx = decodeTransaction(hexToBin(await chain.getRawTransaction(e.txid)));
        if (typeof tx === 'string' || !spendsFaucetCoin(tx, pubHex)) return;
        claimCount++;
        for (const o of tx.outputs) {
          const lock = binToHex(o.lockingBytecode);
          if (lock !== faucetLock && o.token) claimedLocks.add(lock);
        }
        if ((await timeOf(e.height)) >= dayStart) claimsToday++;
      }),
    );
  }
  return { claimedLocks, claimsToday, claimCount, historyTruncated: truncated };
}

export interface FaucetCoins {
  pusd: SpendableUtxo[];
  bch: SpendableUtxo[];
  units: bigint;
}

export async function readFaucetCoins(chain: FaucetChain, c: StarterConfig): Promise<FaucetCoins> {
  const utxos = await chain.getUtxos(c.faucetTokenAddress);
  const pusd = utxos.filter((u) => u.token && u.token.category === c.category && !u.token.nft && u.token.amount > 0n);
  const bch = utxos.filter((u) => !u.token);
  return { pusd, bch, units: pusd.reduce((s, u) => s + u.token!.amount, 0n) };
}

/** Coins for one claim: one random coin that alone covers the claim, else the largest coins until they do. */
export function pickClaimCoins(pusd: SpendableUtxo[], units: bigint, rng: () => number = Math.random): SpendableUtxo[] {
  const single = pusd.filter((u) => u.token!.amount >= units);
  if (single.length) return [single[Math.min(single.length - 1, Math.floor(rng() * single.length))]!];
  const picked: SpendableUtxo[] = [];
  let have = 0n;
  for (const u of [...pusd].sort((a, b) => (b.token!.amount > a.token!.amount ? 1 : b.token!.amount < a.token!.amount ? -1 : 0))) {
    picked.push(u);
    have += u.token!.amount;
    if (have >= units) return picked;
  }
  return [];
}

export function checkStarterSats(c: StarterConfig): void {
  const dust = dustFor(lockingBytecodeOf(c.faucetTokenAddress), { category: c.category, amount: c.claimUnits });
  if (c.starterSats < 2n * dust) throw new StarterError('DUST', `starter output ${c.starterSats} sats is below 2 × token dust (${2n * dust})`);
}

export interface Claim {
  hex: string;
  feeSats: bigint;
}

/** One claim tx: starter output + PUSD change back to the faucet (no burn) + BCH change; fee from the serialized size. */
export function buildClaim(coins: FaucetCoins, picked: SpendableUtxo[], recipientTokenAddress: string, c: StarterConfig, provider: NetworkProvider): Claim {
  checkStarterSats(c);
  const inUnits = picked.reduce((s, u) => s + u.token!.amount, 0n);
  if (inUnits < c.claimUnits) throw new StarterError('FAUCET_EMPTY', 'The faucet has run out of starter PUSD.');
  const changeUnits = inUnits - c.claimUnits;
  const changeSats = 1000n;
  const signer = new SignatureTemplate(c.faucetPriv).unlockP2PKH();
  const bchIn = coins.bch.length ? [[...coins.bch].sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0]!] : [];
  const inputs = [...picked, ...bchIn];
  const inSats = inputs.reduce((s, u) => s + u.satoshis, 0n);
  const build = (fee: bigint) => {
    const b = new TransactionBuilder({ provider }).addInputs(inputs, signer);
    b.addOutput({ to: recipientTokenAddress, amount: c.starterSats, token: { category: c.category, amount: c.claimUnits } });
    let out = c.starterSats;
    if (changeUnits > 0n) {
      b.addOutput({ to: c.faucetTokenAddress, amount: changeSats, token: { category: c.category, amount: changeUnits } });
      out += changeSats;
    }
    const bchChange = inSats - out - fee;
    if (bchChange < 0n) throw new StarterError('FAUCET_NO_BCH', 'The faucet has no BCH left to pay the network fee.');
    if (bchChange >= 546n) b.addOutput({ to: c.faucetAddress, amount: bchChange });
    return b;
  };
  let fee = 0n; // the size loop below converges; a faucet is refused only when the FINAL fee does not fit
  for (let k = 0; k < 3; k++) fee = BigInt(build(fee).getTransactionSize()) * BigInt(c.feeRate ?? 1) + 2n;
  const tx = build(fee);
  const hex = tx.build();
  return { hex, feeSats: fee };
}

export interface ClaimResult {
  txid: string;
  units: bigint;
  feeSats: bigint;
  /** Honest limits, echoed to the UI. */
  claimsToday: number;
}

const CONFLICT = /txn-mempool-conflict|missing-inputs|bad-txns-inputs-missingorspent|already spent|double.?spend/i;

/** The whole claim: validate → per-address and daily checks from the chain → build → broadcast, retrying on a coin conflict. */
export async function claimStarter(chain: FaucetChain, c: StarterConfig, addressInput: string): Promise<ClaimResult> {
  const parsed = parseRecipient(addressInput);
  if (!parsed.ok) throw new StarterError('BAD_ADDRESS', parsed.reason);
  const to = parsed.value;
  const toLock = binToHex(lockingBytecodeOf(to));
  if (toLock === binToHex(lockingBytecodeOf(c.faucetTokenAddress))) throw new StarterError('SELF', 'That is the faucet address.');
  checkStarterSats(c);

  const hist = await readClaimHistory(chain, c);
  if (hist.claimedLocks.has(toLock)) throw new StarterError('ALREADY_CLAIMED', 'This address already claimed its starter PUSD.');
  if (hist.claimsToday >= c.dailyCap) throw new StarterError('DAILY_CAP', `Today's starter PUSD is gone (${c.dailyCap} claims per UTC day). Try again after 00:00 UTC.`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const coins = await readFaucetCoins(chain, c);
    if (coins.units < c.claimUnits) throw new StarterError('FAUCET_EMPTY', 'The faucet has run out of starter PUSD.');
    // a fresh chain read on every attempt drops the coins a competing claim just spent
    const picked = pickClaimCoins(coins.pusd, c.claimUnits, c.rng);
    if (!picked.length) throw new StarterError('FAUCET_EMPTY', 'The faucet has run out of starter PUSD.');
    const claim = buildClaim(coins, picked, to, c, chain);
    try {
      const txid = await chain.sendRawTransaction(claim.hex);
      return { txid, units: c.claimUnits, feeSats: claim.feeSats, claimsToday: hist.claimsToday + 1 };
    } catch (e) {
      lastErr = e;
      if (!CONFLICT.test(String((e as Error).message ?? e))) throw new StarterError('CHAIN', 'The network did not accept the claim. Try again in a minute.');
    }
  }
  void lastErr; // the raw node error is never echoed to the client
  throw new StarterError('BUSY', 'Another claim was in flight. Try again in a moment.');
}
