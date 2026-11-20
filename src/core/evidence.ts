// Measured figures the front page shows, imported from the committed evidence file (never typed into the UI).
import shape from '../../evidence/tx-shape.json';

export interface MeasuredSend { userCoinSats: number; signedSizeBytes: number; minerFeeSats: number; topUpSats: number; poolSubsidySats: number }

/** The standard send: the user's coin already carries enough sats, so the lane pays only the miner fee (no top-up). */
export function standardSend(sends: readonly MeasuredSend[] = shape.sends): MeasuredSend {
  if (sends.length === 0) throw new Error('evidence/tx-shape.json has no measured sends');
  const s = sends.find((x) => x.topUpSats === 0);
  if (!s) throw new Error('evidence/tx-shape.json has no standard (zero top-up) send');
  return s;
}

export const measured = {
  send: standardSend(),
  /** Largest measured lane cost: a small user coin, where the lane also tops up the token output's dust. */
  maxMeasuredSubsidySats: Math.max(...shape.sends.map((s) => s.poolSubsidySats)),
  maxSubsidySats: shape.params.maxSubsidy,
  maxTopUpSats: shape.params.maxTopUp,
  redeemScriptBytes: shape.redeemScriptBytes,
};
