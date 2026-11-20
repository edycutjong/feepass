// A minimal conforming WizardConnect-style signer: signs the requested inputs of a WC transaction object with
// SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS (0x61), Schnorr, P2PKH unlock. Used by tests and the automated wallet-compatibility rig.
// It proves our request is well-formed and signable by a conforming wallet; it does NOT prove Selene or Paytaca sign it.
import {
  binToHex,
  encodeDataPush,
  encodeTransaction,
  flattenBinArray,
  generateSigningSerializationBch,
  hash256,
  secp256k1,
  type TransactionCommon,
} from '@bitauth/libauth';
import { parseExtendedJson } from '@wizardconnect/core';
import type { WcTransactionObject } from 'cashscript';
import { REQUIRED_SIGHASH } from './wizard';

/** Accepts the WC object either with real types or in the extended-JSON wire form a wallet receives over the relay. */
export function signWcTransaction(input: WcTransactionObject | unknown, keys: Map<number, Uint8Array>, sighash = REQUIRED_SIGHASH): string {
  const wc = (isWire(input) ? parseExtendedJson(JSON.stringify(input)) : input) as WcTransactionObject;
  const tx = structuredClone(wc.transaction) as TransactionCommon;
  const sourceOutputs = wc.sourceOutputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis, token: o.token }));
  for (const [index, priv] of keys) {
    const serialization = generateSigningSerializationBch(
      { inputIndex: index, sourceOutputs, transaction: tx },
      { coveredBytecode: sourceOutputs[index]!.lockingBytecode, signingSerializationType: Uint8Array.of(sighash) },
    );
    const sig = secp256k1.signMessageHashSchnorr(priv, hash256(serialization));
    if (typeof sig === 'string') throw new Error(sig);
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(pub);
    tx.inputs[index] = {
      ...tx.inputs[index]!,
      unlockingBytecode: flattenBinArray([encodeDataPush(Uint8Array.of(...sig, sighash)), encodeDataPush(pub)]),
    };
  }
  return binToHex(encodeTransaction(tx));
}

function isWire(x: unknown): boolean {
  const so = (x as { sourceOutputs?: { valueSatoshis?: unknown }[] }).sourceOutputs;
  return typeof so?.[0]?.valueSatoshis === 'string';
}
