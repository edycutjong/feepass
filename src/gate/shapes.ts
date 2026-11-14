// The two hard-coded transaction shapes the wallet-compatibility gate asks a wallet to sign.
// (a) covenant input: the user's PUSD coin + one FeePassPool lane (contract sourceOutput, complete unlock).
// (b) merchant input: the user's PUSD coin + a foreign P2PKH coin (the payee-funded fee variant).
// (a) uses the configured mainnet lane when `gate.lane` is set, otherwise a SYNTHETIC outpoint. (b) always uses a
// SYNTHETIC merchant outpoint. A synthetic tx can be signed for the pre-check but can never broadcast. The report flags
// which one was used.
import { TransactionBuilder, placeholderP2PKHUnlocker, type NetworkProvider, type SpendableUtxo } from 'cashscript';
import { poolContract } from '../core/pool';
import { buildSponsoredSend } from '../core/sponsoredSend';
import { dustFor, lockingBytecodeOf } from '../core/dust';
import { DEFAULT_PARAMS } from '../core/params';
import { toWire, type WizardSignRequest } from '../core/wizard';
import gate from '../config/gate.json';

export const SYNTHETIC_TXID = 'fe'.repeat(32);
const SEND_UNITS = 10n;

export interface ShapeRequest { request: WizardSignRequest; synthetic: boolean; describe: string }

export function shapeA(provider: NetworkProvider, coin: SpendableUtxo, owner: { tokenAddress: string; pathName: string; addressIndex: number }): ShapeRequest {
  const pool = poolContract({ ...DEFAULT_PARAMS, ownerPk: gate.ownerPk, categoryDisplay: gate.categoryDisplay }, provider);
  const cfg = gate.lane as null | { txid: string; vout: number; satoshis: string; units: string };
  const lane: SpendableUtxo = cfg
    ? { txid: cfg.txid, vout: cfg.vout, satoshis: BigInt(cfg.satoshis), token: { category: gate.categoryDisplay, amount: BigInt(cfg.units) }, lockingBytecode: pool.lockingBytecode }
    : { txid: SYNTHETIC_TXID, vout: 0, satoshis: 100_000n, token: { category: gate.categoryDisplay, amount: 1n }, lockingBytecode: pool.lockingBytecode };
  const send = buildSponsoredSend({
    pool, params: DEFAULT_PARAMS, categoryDisplay: gate.categoryDisplay, userUtxo: coin, userAddress: owner.tokenAddress,
    lane, recipient: owner.tokenAddress, amount: SEND_UNITS,
  });
  return {
    synthetic: !cfg,
    describe: `(a) covenant input · send 0.10 PUSD to yourself · pool pays ${send.minerFeeSats} sats fee · you pay 0.01 PUSD`,
    request: wrap(send.builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'FeePass wallet check (a): send 0.10 PUSD to yourself; the pool pays the BCH fee' }), owner),
  };
}

export function shapeB(provider: NetworkProvider, coin: SpendableUtxo, owner: { tokenAddress: string; pathName: string; addressIndex: number }): ShapeRequest {
  const merchantLock = lockingBytecodeOf(gate.merchantAddress);
  const merchant: SpendableUtxo = { txid: SYNTHETIC_TXID, vout: 1, satoshis: 10_000n, lockingBytecode: '' };
  merchant.lockingBytecode = Array.from(merchantLock, (b) => b.toString(16).padStart(2, '0')).join('');
  const cat = gate.categoryDisplay;
  const pay = { category: cat, amount: SEND_UNITS };
  if (coin.token!.amount - SEND_UNITS < 1n) throw new Error('coin holds too little PUSD for shape (b)');
  const change = { category: cat, amount: coin.token!.amount - SEND_UNITS };
  const ownerLock = lockingBytecodeOf(owner.tokenAddress);
  const payDust = dustFor(merchantLock, pay);
  const changeDust = dustFor(ownerLock, change);
  const changeSats = coin.satoshis - payDust >= changeDust ? coin.satoshis - payDust : changeDust;
  const fee = 600n;
  const b = new TransactionBuilder({ provider })
    .addInput(coin, placeholderP2PKHUnlocker(owner.tokenAddress))
    .addInput(merchant, placeholderP2PKHUnlocker(gate.merchantAddress))
    .addOutput({ to: gate.merchantAddress, amount: payDust, token: pay })
    .addOutput({ to: owner.tokenAddress, amount: changeSats, token: change })
    .addOutput({ to: gate.merchantAddress, amount: coin.satoshis + merchant.satoshis - payDust - changeSats - fee });
  return {
    synthetic: true,
    describe: '(b) merchant input · pay 0.10 PUSD to a merchant who adds the BCH fee input',
    request: wrap(b.generateWcTransactionObject({ broadcast: false, userPrompt: 'FeePass wallet check (b): pay 0.10 PUSD; the merchant pays the BCH fee' }), owner),
  };
}

function wrap(proposed: ReturnType<TransactionBuilder['generateWcTransactionObject']>, owner: { pathName: string; addressIndex: number }): WizardSignRequest {
  return { wire: toWire(proposed), proposed, inputPaths: [[0, owner.pathName, owner.addressIndex]] };
}
