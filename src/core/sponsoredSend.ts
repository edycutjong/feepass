// Builds the one transaction shape FeePass ever asks a wallet to sign (F3):
//   in0  user PUSD coin   (placeholder P2PKH unlock; the user's wallet signs it)
//   in1  pool lane        (FeePassPool.sponsorPaid(), complete unlock, no signature)
//   out0 PUSD → recipient
//   out1 PUSD change → user
//   out2 lane → pool, minus the miner fee (and at most T top-up), plus exactly f PUSD
import { TransactionBuilder, placeholderP2PKHUnlocker, type Contract, type SpendableUtxo } from 'cashscript';
import { dustFor, lockingBytecodeOf } from './dust';
import type { PoolParams } from './params';

export interface SponsoredSendInput {
  pool: Contract<any, any, 'p2sh32'>;
  params: PoolParams;
  categoryDisplay: string;
  userUtxo: SpendableUtxo;
  /** The user's token-aware P2PKH cashaddr that owns `userUtxo`. */
  userAddress: string;
  lane: SpendableUtxo;
  /** Recipient token-aware P2PKH cashaddr. P2SH recipients are refused (their dust exceeds T). */
  recipient: string;
  /** PUSD base units to send. */
  amount: bigint;
  /** sats per byte, default 1. */
  feeRate?: number;
}

export interface SponsoredSend {
  builder: TransactionBuilder;
  sizeBytes: number;
  minerFeeSats: bigint;
  topUpSats: bigint;
  /** Total sats the lane loses: miner fee + top-up. */
  poolSubsidySats: bigint;
  outputs: { recipientSats: bigint; changeSats: bigint; laneSats: bigint; changeUnits: bigint; laneUnits: bigint };
}

export class SendError extends Error {
  constructor(
    public code:
      | 'NOT_PUSD'
      | 'NFT_COIN'
      | 'INSUFFICIENT_PUSD'
      | 'BAD_AMOUNT'
      | 'P2SH_RECIPIENT'
      | 'TOPUP_EXCEEDS_CAP'
      | 'LANE_NOT_PUSD'
      | 'LANE_TOO_SMALL'
      | 'SUBSIDY_EXCEEDS_CAP',
    message: string,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

function isP2pkh(bytecode: Uint8Array): boolean {
  return bytecode.length === 25 && bytecode[0] === 0x76 && bytecode[1] === 0xa9 && bytecode[2] === 0x14;
}

export function buildSponsoredSend(i: SponsoredSendInput): SponsoredSend {
  const { params, categoryDisplay: cat } = i;
  const feeRate = i.feeRate ?? 1;
  const user = i.userUtxo.token;
  const laneTok = i.lane.token;

  if (!user || user.category !== cat) throw new SendError('NOT_PUSD', 'The selected coin holds no PUSD.');
  if (user.nft) throw new SendError('NFT_COIN', 'Coins carrying an NFT are never spent by FeePass.');
  if (i.amount <= 0n) throw new SendError('BAD_AMOUNT', 'Amount must be at least 0.01 PUSD.');
  // out1 must stay a PUSD output (R8), so at least 1 base unit has to remain as change.
  const changeUnits = user.amount - i.amount - params.feeTokens;
  if (changeUnits < 1n)
    throw new SendError('INSUFFICIENT_PUSD', 'This coin needs amount + fee + 0.01 PUSD left as change.');
  if (!laneTok || laneTok.category !== cat || laneTok.nft)
    throw new SendError('LANE_NOT_PUSD', 'Lane holds no PUSD (R7) or carries an NFT.');

  const recipientLock = lockingBytecodeOf(i.recipient);
  if (!isP2pkh(recipientLock))
    throw new SendError('P2SH_RECIPIENT', 'Send to a regular (P2PKH) address; script addresses need more dust than the pool covers.');
  const userLock = lockingBytecodeOf(i.userAddress);

  const sendTok = { category: cat, amount: i.amount };
  const changeTok = { category: cat, amount: changeUnits };
  const laneUnits = laneTok.amount + params.feeTokens;
  const laneOutTok = { category: cat, amount: laneUnits };

  const recipientSats = dustFor(recipientLock, sendTok);
  const changeDust = dustFor(userLock, changeTok);
  // All of the user's sats stay with the user; the lane only tops up when one coin cannot carry two token dusts.
  const changeSats = i.userUtxo.satoshis - recipientSats >= changeDust ? i.userUtxo.satoshis - recipientSats : changeDust;
  const topUpSats = recipientSats + changeSats - i.userUtxo.satoshis;
  if (topUpSats > params.maxTopUp)
    throw new SendError('TOPUP_EXCEEDS_CAP', `Coin too small: needs ${topUpSats} sats top-up, cap is ${params.maxTopUp}.`);

  const laneLock = lockingBytecodeOf(i.pool.tokenAddress);
  const laneDust = dustFor(laneLock, laneOutTok);

  const assemble = (minerFee: bigint) => {
    const laneSats = i.lane.satoshis - minerFee - topUpSats;
    const b = new TransactionBuilder({ provider: i.pool.provider })
      .addInput(i.userUtxo, placeholderP2PKHUnlocker(i.userAddress))
      .addInput(i.lane, i.pool.unlock.sponsorPaid())
      .addOutput({ to: i.recipient, amount: recipientSats, token: sendTok })
      .addOutput({ to: i.userAddress, amount: changeSats, token: changeTok })
      .addOutput({ to: i.pool.tokenAddress, amount: laneSats, token: laneOutTok });
    return { b, laneSats };
  };

  // Fee from the serialized size (placeholder signature has the final size), iterated to a fixed point.
  let minerFee = 0n;
  let built = assemble(minerFee);
  for (let k = 0; k < 4; k++) {
    const size = BigInt(built.b.getTransactionSize());
    const next = BigInt(Math.ceil(Number(size) * feeRate));
    if (next === minerFee) break;
    minerFee = next;
    built = assemble(minerFee);
  }
  const subsidy = minerFee + topUpSats;
  if (subsidy > params.maxSubsidy)
    throw new SendError('SUBSIDY_EXCEEDS_CAP', `Subsidy ${subsidy} sats exceeds the per-tx cap ${params.maxSubsidy}.`);
  if (built.laneSats < laneDust) throw new SendError('LANE_TOO_SMALL', 'Lane cannot cover this fee; pick another lane.');

  return {
    builder: built.b,
    sizeBytes: Number(built.b.getTransactionSize()),
    minerFeeSats: minerFee,
    topUpSats,
    poolSubsidySats: subsidy,
    outputs: { recipientSats, changeSats, laneSats: built.laneSats, changeUnits, laneUnits },
  };
}

/** A lane is usable only if it holds PUSD fungibles (no NFT) and can lose C sats and still keep its own dust. */
export function isUsableLane(lane: SpendableUtxo, categoryDisplay: string, params: PoolParams, laneLock: Uint8Array): boolean {
  const t = lane.token;
  if (!t || t.category !== categoryDisplay || t.nft) return false;
  const dust = dustFor(laneLock, { category: categoryDisplay, amount: t.amount + params.feeTokens });
  return lane.satoshis >= params.maxSubsidy + dust;
}
