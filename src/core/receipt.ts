// The toll ticket. Every figure is read off the signed, broadcast transaction and its source outputs, never off the form.
import { binToHex, decodeTransaction, hexToBin, lockingBytecodeToCashAddress, type Output } from '@bitauth/libauth';
import type { WcTransactionObject } from 'cashscript';

export interface Ticket {
  txid: string;
  /** "No spendable BCH used." only when the inputs are exactly the user's PUSD coin + one pool lane (ui.md S4). */
  headline: string | null;
  inputs: { userCoin: boolean; poolLane: boolean; count: number };
  recipient: string;
  sentUnits: bigint;
  feeUnits: bigint;
  /** S = lane in − lane out: the miner fee plus the actual top-up. */
  poolSubsidySats: bigint;
  minerFeeSats: bigint;
  topUpSats: bigint;
  coinSatsBefore: bigint;
  coinSatsAfter: bigint;
  sizeBytes: number;
  spendableBefore: bigint | null;
  spendableAfter: bigint | null;
  /** True only when both snapshots are known and equal (F4's line "Your BCH balance didn't change."). */
  balanceUnchanged: boolean;
}

export class TicketError extends Error {}

const same = (a: Uint8Array, b: Uint8Array) => binToHex(a) === binToHex(b);

export function computeTicket(o: {
  txid: string;
  hex: string;
  proposed: Pick<WcTransactionObject, 'sourceOutputs'>;
  categoryDisplay: string;
  userLock: Uint8Array;
  poolLock: Uint8Array;
  spendableBefore: bigint | null;
  spendableAfter: bigint | null;
}): Ticket {
  const tx = decodeTransaction(hexToBin(o.hex));
  if (typeof tx === 'string') throw new TicketError(`undecodable transaction: ${tx}`);
  const src = o.proposed.sourceOutputs as unknown as Output[];
  if (src.length !== tx.inputs.length) throw new TicketError('source outputs do not match the inputs');
  const cat = o.categoryDisplay;
  const isPusd = (x: Output | undefined) => !!x?.token && binToHex(x.token.category) === cat && !x.token.nft;
  const in0 = src[0], in1 = src[1];
  const userCoin = tx.inputs.length === 2 && !!in0 && same(in0.lockingBytecode, o.userLock) && isPusd(in0);
  const poolLane = tx.inputs.length === 2 && !!in1 && same(in1.lockingBytecode, o.poolLock) && isPusd(in1);
  const [out0, out1, out2] = tx.outputs;
  if (!out0 || !out1 || !out2 || tx.outputs.length !== 3) throw new TicketError('not the FeePass 3-output shape');
  if (!isPusd(out0) || !isPusd(out1) || !isPusd(out2)) throw new TicketError('an output carries no PUSD');
  if (!same(out2.lockingBytecode, o.poolLock)) throw new TicketError('output 2 does not return to the pool');

  const inSats = src.reduce((s, x) => s + x.valueSatoshis, 0n);
  const outSats = tx.outputs.reduce((s, x) => s + x.valueSatoshis, 0n);
  const minerFeeSats = inSats - outSats;
  const poolSubsidySats = in1!.valueSatoshis - out2.valueSatoshis;
  const recipient = lockingBytecodeToCashAddress({ bytecode: out0.lockingBytecode, prefix: 'bitcoincash', tokenSupport: true });
  const balanceUnchanged = o.spendableBefore !== null && o.spendableAfter !== null && o.spendableBefore === o.spendableAfter;
  return {
    txid: o.txid,
    headline: userCoin && poolLane ? 'No spendable BCH used.' : null,
    inputs: { userCoin, poolLane, count: tx.inputs.length },
    recipient: typeof recipient === 'string' ? recipient : recipient.address,
    sentUnits: out0.token!.amount,
    feeUnits: out2.token!.amount - (in1!.token?.amount ?? 0n),
    poolSubsidySats,
    minerFeeSats,
    topUpSats: poolSubsidySats - minerFeeSats,
    coinSatsBefore: in0!.valueSatoshis,
    coinSatsAfter: out1.valueSatoshis,
    sizeBytes: o.hex.length / 2,
    spendableBefore: o.spendableBefore,
    spendableAfter: o.spendableAfter,
    balanceUnchanged,
  };
}
