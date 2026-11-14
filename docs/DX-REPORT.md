# DX report: CashScript · WizardConnect · Fulcrum

Friction found while building FeePass, written as it happened. Dates are UTC.

## 2026-11-14

- **cashc 0.14.0 artifacts carry `updatedAt`.** Every compile changes the artifact bytes and its hash. `scripts/compile.ts`
  drops the field so the committed artifact is reproducible and CI can recompile and `git diff` it.
- **The real sponsored-send tx is smaller than our estimate.** The compiled `FeePassPool` redeem script is 160 bytes
  (56 opcodes) and the signed 2-input / 3-output send is 572 bytes, so 572 sats at 1 sat/B (`evidence/tx-shape.json`).
- **WizardConnect relays the sign request with `JSON.stringify`.** CashScript's `generateWcTransactionObject()` returns
  `BigInt` and `Uint8Array` values, so passing it straight to `DappConnectionManager.signTransaction()` throws
  `Do not know how to serialize a BigInt` before anything reaches the wallet. Fix: send the BCH WalletConnect wire form,
  `JSON.parse(stringify(obj))` with libauth's `stringify` (`"<bigint: 5n>"`, `"<Uint8Array: 0x…>"`), which
  `@wizardconnect/core`'s `parseExtendedJson` turns back into real types. `src/core/wizard.ts` `toWire()`.
- **`TransactionBuilder` refuses outputs whose address prefix does not match the provider's network**
  (`OutputAddressNetworkMismatchError`). Useful: a mainnet provider can never build a tx paying a `bchtest:` address.
- **`MockNetworkProvider` accepts a zero-amount fungible token output with no NFT**, which consensus rejects. Our tests
  model a token-less coin as "no token" instead of `amount: 0`.
- **A default-parameter trap in our own helpers:** passing `undefined` for an optional token argument picks up the default
  token. Tests use `null` for "no token".
- **Chipnet funding needs a human.** The chipnet faucet we found asks for a captcha, so the hot wallet's chipnet run waits for
  a person to request coins.
