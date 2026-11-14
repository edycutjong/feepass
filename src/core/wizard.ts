// The WizardConnect side of a sponsored send: the request we hand the wallet, and the checks we run on what comes back.
import {
  binToHex,
  decodeTransaction,
  encodeTransaction,
  hash160,
  hash256,
  stringify,
  type TransactionCommon,
} from '@bitauth/libauth';
import type { WcTransactionObject } from 'cashscript';
import type { SponsoredSend } from './sponsoredSend';

/** WizardConnect protocol: wallets MUST sign with SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS. */
export const REQUIRED_SIGHASH = 0x61;

/** [inputIndex, pathName, addressIndex] — the shape of `SignTransactionRequest.inputPaths` in @wizardconnect/core 0.2.x. */
export type InputPath = [number, string, number];

export interface WizardSignRequest {
  /** What goes over the relay: the WC object in extended-JSON form (bigint → "<bigint: 5n>", bytes → "<Uint8Array: 0x…>").
   *  The relay JSON.stringify()s the message, so raw BigInt/Uint8Array values would throw (found in the P1a relay test). */
  wire: unknown;
  /** The same object with real types, kept locally to verify what the wallet returns. */
  proposed: WcTransactionObject;
  inputPaths: InputPath[];
}

/** The BCH WalletConnect convention (`JSON.parse(stringify(obj))`, libauth) that WizardConnect wallets parse back. */
export function toWire(obj: WcTransactionObject): unknown {
  return JSON.parse(stringify(obj));
}

/** Only input 0 (the user's coin) needs a wallet signature; the pool input's unlock is already complete. */
export function toWizardRequest(send: SponsoredSend, userPath: { pathName: string; addressIndex: number }, userPrompt?: string): WizardSignRequest {
  const proposed = send.builder.generateWcTransactionObject({ broadcast: false, userPrompt });
  return { wire: toWire(proposed), proposed, inputPaths: [[0, userPath.pathName, userPath.addressIndex]] };
}

export class VerifyError extends Error {
  constructor(public code: 'DECODE' | 'SHAPE' | 'INPUTS' | 'OUTPUTS' | 'POOL_UNLOCK' | 'SIGHASH' | 'SIGNER' | 'FEE', message: string) {
    super(message);
    this.name = 'VerifyError';
  }
}

interface Push { data: Uint8Array; next: number }
function readPush(b: Uint8Array, at: number): Push | undefined {
  const op = b[at];
  if (op === undefined) return undefined;
  if (op >= 1 && op <= 75) return { data: b.slice(at + 1, at + 1 + op), next: at + 1 + op };
  if (op === 0x4c) { const n = b[at + 1]!; return { data: b.slice(at + 2, at + 2 + n), next: at + 2 + n }; }
  return undefined;
}

export interface VerifiedTx { txid: string; hex: string; sizeBytes: number; feeSats: bigint; sighashType: number }

/**
 * Refuse anything the wallet changed: same inputs (outpoints, sequence), byte-identical outputs, untouched pool unlock,
 * input 0 signed by the expected key with sighash 0x61, and a fee rate of at least 1 sat/B.
 */
export function verifySignedTx(signedHex: string, proposed: WcTransactionObject, userLockingBytecode: Uint8Array): VerifiedTx {
  const bytes = Uint8Array.from(signedHex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  const tx = decodeTransaction(bytes);
  if (typeof tx === 'string') throw new VerifyError('DECODE', `Wallet returned an undecodable transaction: ${tx}`);
  const want = proposed.transaction as TransactionCommon;
  if (tx.inputs.length !== want.inputs.length || tx.outputs.length !== want.outputs.length)
    throw new VerifyError('SHAPE', 'The wallet changed the transaction (input/output count).');
  tx.inputs.forEach((inp, k) => {
    const w = want.inputs[k]!;
    if (binToHex(inp.outpointTransactionHash) !== binToHex(w.outpointTransactionHash) || inp.outpointIndex !== w.outpointIndex || inp.sequenceNumber !== w.sequenceNumber)
      throw new VerifyError('INPUTS', `The wallet changed input ${k}.`);
  });
  const enc = (t: TransactionCommon) => binToHex(encodeTransaction({ ...t, inputs: t.inputs.map((x) => ({ ...x, unlockingBytecode: new Uint8Array() })) }));
  if (enc(tx) !== enc(want)) throw new VerifyError('OUTPUTS', 'The wallet changed an output, the version or the locktime.');
  if (binToHex(tx.inputs[1]!.unlockingBytecode) !== binToHex(want.inputs[1]!.unlockingBytecode))
    throw new VerifyError('POOL_UNLOCK', 'The wallet changed the pool input.');

  const u = tx.inputs[0]!.unlockingBytecode;
  const sig = readPush(u, 0);
  const pk = sig && readPush(u, sig.next);
  if (!sig || !pk || pk.next !== u.length || pk.data.length !== 33)
    throw new VerifyError('SIGNER', 'Input 0 is not a P2PKH signature + public key.');
  const sighashType = sig.data[sig.data.length - 1]!;
  if (sighashType !== REQUIRED_SIGHASH)
    throw new VerifyError('SIGHASH', `Input 0 signed with sighash 0x${sighashType.toString(16)}; WizardConnect requires 0x61.`);
  if (binToHex(hash160(pk.data)) !== binToHex(userLockingBytecode.slice(3, 23)))
    throw new VerifyError('SIGNER', 'Input 0 was signed by a different key than the coin owner.');

  const inSats = proposed.sourceOutputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  const outSats = tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  const feeSats = inSats - outSats;
  if (feeSats < BigInt(bytes.length)) throw new VerifyError('FEE', `Fee ${feeSats} sats is below 1 sat/B for ${bytes.length} B.`);
  const txid = binToHex(hash256(bytes).slice().reverse());
  return { txid, hex: signedHex, sizeBytes: bytes.length, feeSats, sighashType };
}
