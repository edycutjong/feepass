# DX report: CashScript · WizardConnect · Fulcrum

Friction found while building FeePass, written as it happened. Dates are UTC.

## 2026-11-14

- **cashc 0.14.0 artifacts carry `updatedAt`.** Every compile changes the artifact bytes and its hash. `scripts/compile.ts`
  drops the field so the committed artifact is reproducible and CI can recompile and `git diff` it.
- **Measured shape.** The compiled `FeePassPool` redeem script is 160 bytes (56 opcodes) and the signed 2-input /
  3-output send is 572 bytes (`evidence/tx-shape.json`). The builder pays 580 sats: 1 sat/B plus 8 bytes of headroom in
  case the wallet signs with a longer ECDSA (DER) signature instead of a 65-byte Schnorr one. The covenant's `maxSubsidy`
  (2,000 sats) is a per-transaction ceiling on what a lane can lose, not the fee itself.
- **WizardConnect relays the sign request with `JSON.stringify`.** CashScript's `generateWcTransactionObject()` returns
  `BigInt` and `Uint8Array` values, so passing it straight to `DappConnectionManager.signTransaction()` throws
  `Do not know how to serialize a BigInt` before anything reaches the wallet. Fix: send the BCH WalletConnect wire form,
  `JSON.parse(stringify(obj))` with libauth's `stringify` (`"<bigint: 5n>"`, `"<Uint8Array: 0x…>"`), which
  `@wizardconnect/core`'s `parseExtendedJson` turns back into real types. `src/core/wizard.ts` `toWire()`.
- **`TransactionBuilder` refuses outputs whose address prefix does not match the provider's network**
  (`OutputAddressNetworkMismatchError`). Useful: a mainnet provider can never build a tx paying a `bchtest:` address.
- **A zero-amount fungible token output silently becomes a plain BCH output.** `TransactionBuilder` only rejects
  negative token amounts, and libauth's `encodeTokenPrefix` drops a token with no NFT and `amount < 1`, so
  `MockNetworkProvider` sees a token-less output (read from the library source). Our tests model a token-less coin as
  "no token" instead of `amount: 0`, and `scripts/split.ts` omits the PUSD change output when none is left.
- **A default-parameter trap in our own helpers:** passing `undefined` for an optional token argument picks up the default
  token. Tests use `null` for "no token".
- **Chipnet funding needs a human.** The chipnet faucet we found (https://tbch.googol.cash/) asks for a captcha, so a person had to
  request the coins; the chipnet run then completed on 2026-11-20 (`evidence/chipnet-send.json`).
- **Verify the wallet's signature before broadcasting, not just its shape.** Checking the sighash byte and the public key
  is not enough: a malformed signature with the right key would pass. `verifySignedTx` now runs the whole signed tx
  through libauth's BCH 2026 VM (standard rules, the rules mainnet runs since May 2026) against the proposed source
  outputs, which checks the user's signature and every covenant rule locally.
- **…but only the inputs the request actually completes.** Our first VM check also evaluated the merchant input of the
  wallet-check shape (b), which still carries a placeholder, so every shape-(b) signature would have read as a failure.
  `verifySignedTx` takes the input indexes to evaluate; the sponsored send checks all of them, shape (b) only input 0.
  `test/shapes.test.ts` runs both shapes through the verifier.
