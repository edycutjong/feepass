# FeePass for judges

Live page: <https://feepass.edycu.dev/judge/> (same content, plus the pool's live status).

**FeePass lets a wallet that holds PUSD but no spendable BCH send PUSD on Bitcoin Cash mainnet: a covenant pool lane pays the miner fee, and the sender pays exactly 0.01 PUSD back in the same transaction.**

## Try it: about 60 seconds

1. Open <https://feepass.edycu.dev> on a laptop and press **Connect wallet**. Scan the QR with a WizardConnect wallet and approve (the wallet gate targets Selene and Paytaca; neither is verified yet, see Honest limits). The app is mainnet only.
2. No PUSD? Press **Get 0.25 starter PUSD**: one claim per address, 3 per UTC day. No BCH is needed for it.
3. Send 0.10 PUSD. The recipient is prefilled (it returns to the faucet). Press **Send** and approve one signature: your wallet signs only your own coin.
   No wallet handy? Open the [first mainnet send](https://bchexplorer.info/tx/d59f120b5852280d98d6a84379c08e5b3cc11015a9c0f637e60577884aa6f8b7) and read in0 (the sender's PUSD coin), in1 (the lane) and out2 (the lane back with +0.01 PUSD).
4. Read the ticket: what you sent, the 0.01 PUSD you paid, the lane that paid the miner fee, your spendable BCH before and after (read from the chain), and an explorer link.

## Receipts on chain

| What | Proof | Detail |
|---|---|---|
| First mainnet send | [`d59f120b…f8b7`](https://bchexplorer.info/tx/d59f120b5852280d98d6a84379c08e5b3cc11015a9c0f637e60577884aa6f8b7) | 0.10 PUSD sent; the lane paid the 580-sat miner fee; exactly 0.01 PUSD went back to the pool; sender spendable BCH 0 → 0; 572 bytes. Signed by a headless test key through the app's own builder and VM check, not a named wallet. The sender's coin came from the operator's prep tx `7c0b37c3…7f55`. Record: [`evidence/mainnet-send.json`](evidence/mainnet-send.json) |
| Pool lane funded | [`9d80b411…7dee`](https://bchexplorer.info/tx/9d80b411ce736d775219d6ef7ff6dadf2c24032ceafaa9cdddbe097132197dee) | One lane of 100,000 sats + the 0.01 PUSD seed. 20 lanes is the design target. All operator txs: [`evidence/mainnet-txs.csv`](evidence/mainnet-txs.csv) |
| Same send on chipnet | [`78be2edf…f848c`](https://chipnet.imaginary.cash/tx/78be2edfa73b406c8a8b7bec30d633ddb8b3cf30aab34edc017ab0a6556f848c) | Earlier run on the public test network with a test token in place of PUSD |
| The covenant | [`contracts/FeePassPool.cash`](contracts/FeePassPool.cash) | Eight rules (R1–R8): fixed 2-in/3-out shape, the lane comes back with exactly +0.01 PUSD, a lane loses at most 2,000 sats per send, at most 675 sats of dust top-up |
| Tests | [CI/CD](https://github.com/edycutjong/feepass/actions/workflows/ci.yml) | 189 unit + covenant VM tests, 30 Playwright E2E (15 × desktop + mobile), Lighthouse CI, CodeQL, gitleaks over full history |

## Reproduce

```bash
git clone https://github.com/edycutjong/feepass && cd feepass && npm ci && npm run dev   # the app, reading mainnet
npm test                                                                                 # covenant, builder and flow on the BCH VM, offline
npx tsx scripts/mainnet-send.ts --network mainnet --authorized-cap <bch>                 # operator only: needs the operator's funded key files and a written cap
```

## Honest limits

1. One funded lane today (target 20). Two sends in the same moment: the second is asked to re-sign on another lane or retry.
2. No named wallet verified yet. FeePass asks the wallet to sign input 0 only, with sighash 0x61 (SIGHASH_ALL|FORKID|UTXOS); that is protocol-tested through the real relay with a headless wallet. Whether a given wallet accepts it is exactly what [`/gate.html`](https://feepass.edycu.dev/gate.html) records.
3. The starter faucet is small: 0.25 PUSD per address, 3 claims per UTC day.
4. The covenant does not pick the recipient. Your own signature (sighash 0x61) binds the outputs, as far as your wallet shows them.
5. Not "zero BCH": a token coin always carries a few hundred sats of dust; the claim is no *spendable* BCH.

## Links

[Live app](https://feepass.edycu.dev) · [Pool board](https://feepass.edycu.dev/pool) · [Pitch deck](https://feepass.edycu.dev/deck/) · [Widget Factory presentation](https://docs.google.com/presentation/d/1cqIM2GuEVrLRrAz3gNQu9_Uvzr4C1IgKN67-z_rSNao/edit?usp=sharing) · [README](README.md) · [Architecture](docs/ARCHITECTURE.md)
