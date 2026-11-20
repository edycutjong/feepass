# FeePass: demo and reproduction

Everything here can be run from a fresh clone. Nothing is a recording: each number names the command or file that produces it.

## Status

| Piece | State |
|---|---|
| App, starter route, pool page | live at <https://feepass.edycu.dev> |
| Mainnet pool (20 lanes) | **not funded yet**; the app shows "Pool not open yet" and no mainnet txid exists in this repo |
| Wallet compatibility (Selene, Paytaca) | **unverified**; record it on `/gate.html` |
| Sponsored send on a real chain | **chipnet**, 2026-11-20: txid `78be2edfa73b406c8a8b7bec30d633ddb8b3cf30aab34edc017ab0a6556f848c` (test token in place of PUSD, headless test key; section 4) |

When the operator tools first run on mainnet, the txids are appended to `evidence/mainnet-txs.csv` and this table is updated.

## 1. Run the tests (offline)

```bash
npm install
npm test
```

Expected: `Test Files 13 passed (13)`, `Tests 183 passed | 1 skipped (184)`; the skipped test checks the built bundle and runs after `npm run build`.

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

The relay run in section 3 used the exact 572-sat fee; the 580 here adds 8 bytes of ECDSA headroom. Recompute it: `npx tsx scripts/measure-shape.ts` (offline; compiles the covenant and serializes a signed send).

## 3. Check the wallet protocol (real relay, mock coins)

```bash
npx tsx scripts/relay-roundtrip.ts
```

A headless conforming wallet connects through the real WizardConnect relay, receives the sign request for input 0, signs with sighash 0x61, and the BCH VM accepts the transaction. The recorded run is `evidence/relay-roundtrip.json`. This is a protocol-level check, not a Selene or Paytaca result.

## 4. A sponsored send on chipnet (real chain, test token)

```bash
npx tsx scripts/chipnet-spike.ts --network chipnet   # needs tBCH on the hot-wallet key; --network mock runs it offline
```

The script mints a test token standing in for PUSD (chipnet has no PUSD), seeds one pool lane (100,000 sats + 1 unit), gives a separate user key one 1,000-sat coin with 200 units and no other BCH, then builds the send with `buildSponsoredSend`, signs input 0 with a headless key (sighash 0x61), checks it with `verifySignedTx` on the BCH 2026 VM and broadcasts it. The 2026-11-20 run, read back from a chipnet Fulcrum server:

| Figure | Value |
|---|---|
| Genesis txid | `204de942da7742dfb164a56ac224c8df5dccbc145ca1edee719ccff961f84990` |
| Sponsored send txid | `78be2edfa73b406c8a8b7bec30d633ddb8b3cf30aab34edc017ab0a6556f848c` |
| Shape | 2 inputs, 3 outputs, 572 bytes |
| Miner fee | 580 sats, paid by the lane |
| Lane cost | 882 sats = 580 fee + 302 top-up (the user coin held 1,000 sats; two token outputs need 651 each) |
| Pool PUSD-side | 1 unit seed + exactly 1 fee unit |
| User spendable BCH | 0 before, 0 after |

Record: `evidence/chipnet-send.json`, rows: `evidence/chipnet-txs.csv`.

## 5. Use it with a real wallet (needs the funded pool)

1. Open <https://feepass.edycu.dev>, press **Connect wallet**, approve in a WizardConnect wallet.
2. Press **Get 0.25 starter PUSD** if the wallet holds none (the starter faucet is not funded yet; check `/api/feepass?op=health`).
3. Enter a mainnet recipient and an amount, press **Send**, approve one signature request.
4. On the ticket, compare "spendable BCH before" and "after": the send does not touch them. Open the txid in the explorer (<https://bchexplorer.info/tx/>) and check inputs `in0` (yours) and `in1` (the lane), and that `out2` returns to the pool with exactly 0.01 PUSD more.

## 6. Operator tools (mainnet spends need an explicit cap)

```bash
npx tsx scripts/deploy.ts ...   # derive and record the pool config
npx tsx scripts/split.ts ... --bch-usd <price>   # 20 lanes in one transaction
npx tsx scripts/sweep.ts ...    # owner withdraw: collect PUSD revenue and BCH
```

Mainnet runs require `--authorized-cap`; each txid is appended to `evidence/mainnet-txs.csv`. See [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-operating-it).
