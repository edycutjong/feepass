// Measured figures the front page shows, imported from the committed evidence file (never typed into the UI).
import shape from '../../evidence/tx-shape.json';

export interface MeasuredSend { userCoinSats: number; signedSizeBytes: number; minerFeeSats: number; topUpSats: number; poolSubsidySats: number }

/** The standard send: the user's coin already carries enough sats, so the lane pays only the miner fee (no top-up). */
export function standardSend(sends: readonly MeasuredSend[] = shape.sends): MeasuredSend {
  const s = sends.find((x) => x.topUpSats === 0) ?? sends[0];
  if (!s) throw new Error('evidence/tx-shape.json has no measured sends');
  return s;
}

export const measured = {
  send: standardSend(),
  maxSubsidySats: shape.params.maxSubsidy,
  redeemScriptBytes: shape.redeemScriptBytes,
};
