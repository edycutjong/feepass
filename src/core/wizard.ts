// The WizardConnect side of a sponsored send: the request we hand the wallet, and the checks we run on what comes back.
import {
  binToHex,
  createVirtualMachineBch2026,
  decodeTransaction,
  encodeTransaction,
  hash160,
  hash256,
  hexToBin,
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
  constructor(public code: 'DECODE' | 'SHAPE' | 'INPUTS' | 'OUTPUTS' | 'POOL_UNLOCK' | 'SIGHASH' | 'SIGNER' | 'FEE' | 'SCRIPT', message: string) {
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

// BCH mainnet has run the 2026 rules since the May 2026 upgrade; standard (relay) mode.
const vm = createVirtualMachineBch2026(true);

/**
 * Refuse anything the wallet changed: same inputs (outpoints, sequence), byte-identical outputs, version and locktime,
 * untouched pool unlock, input 0 signed by the expected key with sighash 0x61, a fee rate of at least 1 sat/B, and
 * finally the whole tx must pass the BCH VM (standard rules) against the proposed source outputs: that checks the
 * user's signature itself and every covenant rule before anything is broadcast.
 */
/**
 * `vmInputs`: 'all' (default) runs the whole tx through the VM — right for the sponsored send, whose pool input carries a
 * complete unlock. Pass the indexes the wallet signed (e.g. [0]) when other inputs still hold placeholders, as in the
 * merchant-input wallet check, where the merchant's own signature is not part of the request.
 */
export function verifySignedTx(signedHex: string, proposed: WcTransactionObject, userLockingBytecode: Uint8Array, vmInputs: 'all' | number[] = 'all'): VerifiedTx {
  // strict: whole-byte hex only, so the bytes verified here are exactly the bytes broadcast (returned below as `hex`)
  if (typeof signedHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(signedHex))
    throw new VerifyError('DECODE', 'Wallet returned something that is not transaction hex.');
  const bytes = hexToBin(signedHex);
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
  const sourceOutputs = proposed.sourceOutputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis, token: o.token }));
  if (vmInputs === 'all') {
    const ok = vm.verify({ sourceOutputs, transaction: tx });
    if (ok !== true) throw new VerifyError('SCRIPT', `The signed transaction does not validate: ${ok}`);
  } else {
    for (const inputIndex of vmInputs) {
      const ok = vm.stateSuccess(vm.evaluate({ inputIndex, sourceOutputs, transaction: tx }));
      if (ok !== true) throw new VerifyError('SCRIPT', `Input ${inputIndex} does not validate: ${ok}`);
    }
  }
  const txid = binToHex(hash256(bytes).slice().reverse());
  return { txid, hex: binToHex(bytes), sizeBytes: bytes.length, feeSats, sighashType };
}
