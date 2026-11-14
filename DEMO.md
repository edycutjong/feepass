# FeePass: demo and reproduction

Everything here can be run from a fresh clone. Nothing is a recording: each number names the command or file that produces it.

## Status

| Piece | State |
|---|---|
| App, starter route, pool page | live at <https://feepass.edycu.dev> |
| Mainnet pool (20 lanes) | **not funded yet**; the app shows "Pool not open yet" and no mainnet txid exists in this repo |
| Wallet compatibility (Selene, Paytaca) | **unverified**; record it on `/gate.html` |

When the operator tools first run on mainnet, the txids are appended to `evidence/mainnet-txs.csv` and this table is updated.

## 1. Run the tests (offline)

```bash
npm install
npm test
```

Expected: `Test Files 12 passed (12)`, `Tests 174 passed (174)`.

## 2. Check the transaction shape

```bash
cat evidence/tx-shape.json
```

| Figure | Field | Value |
|---|---|---|
| Signed send size | `sends[0].signedSizeBytes` | 572 bytes |
| Miner fee | `sends[0].minerFeeSats` | 580 sats (1 sat/B plus 8 bytes ECDSA headroom) |
| Per-send cap | `params.maxSubsidy` | 2,000 sats |
| Fee the user pays | `params.feeTokens` | 1 base unit = 0.01 PUSD (2 decimals) |
| Covenant size | `redeemScriptBytes` | 160 bytes |

Recompute it: `npx tsx scripts/measure-shape.ts` (offline; compiles the covenant and serializes a signed send).

## 3. Check the wallet protocol (real relay, mock coins)

```bash
npx tsx scripts/relay-roundtrip.ts
```

A headless conforming wallet connects through the real WizardConnect relay, receives the sign request for input 0, signs with sighash 0x61, and the BCH VM accepts the transaction. The recorded run is `evidence/relay-roundtrip.json`. This is a protocol-level check, not a Selene or Paytaca result.

## 4. Use it with a real wallet (needs the funded pool)

1. Open <https://feepass.edycu.dev>, press **Connect wallet**, approve in a WizardConnect wallet.
2. Press **Get 0.25 starter PUSD** if the wallet holds none.
3. Enter a mainnet recipient and an amount, press **Send**, approve one signature request.
4. On the ticket, compare "spendable BCH before" and "after": the send does not touch them. Open the txid in the explorer (<https://bchexplorer.info/tx/>) and check inputs `in0` (yours) and `in1` (the lane), and that `out2` returns to the pool with exactly 0.01 PUSD more.

## 5. Operator tools (mainnet spends need an explicit cap)

```bash
npx tsx scripts/deploy.ts ...   # derive and record the pool config
npx tsx scripts/split.ts ... --bch-usd <price>   # 20 lanes in one transaction
npx tsx scripts/sweep.ts ...    # owner withdraw: collect PUSD revenue and BCH
```

Mainnet runs require `--authorized-cap`; each txid is appended to `evidence/mainnet-txs.csv`. See [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-operating-it).
