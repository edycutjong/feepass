<div align="center">
  <img src="docs/assets/icon.svg" alt="FeePass icon" width="144">
  <h1>FeePass 🎫</h1>
  <p><em>A covenant pays the Bitcoin Cash network fee. You pay it back in PUSD.</em></p>
  <img src="docs/assets/readme-hero-animated.svg" alt="FeePass: a covenant pays the Bitcoin Cash network fee and you pay it back in PUSD. Lane 14 turns green; the ticket prints: fee paid in PUSD, no spendable BCH used, txid on the explorer." width="100%">

  <br/>

  [![Live Demo](https://img.shields.io/badge/🚀_Live-Demo-1F4F9A?style=for-the-badge)](https://feepass.edycu.dev)
  [![Built for BCH BLAZE 2026](https://img.shields.io/badge/DoraHacks-BCH_BLAZE_2026-8b5cf6?style=for-the-badge)](https://dorahacks.io/hackathon/bchblaze2026/detail)

  <br/>

  ![Bitcoin Cash](https://img.shields.io/badge/Bitcoin_Cash-mainnet-0AC18E?style=flat)
  ![CashScript](https://img.shields.io/badge/CashScript_0.14-1F4F9A?style=flat)
  ![Vue](https://img.shields.io/badge/Vue_3-42b883?style=flat&logo=vue.js&logoColor=white)
  ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
  [![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

</div>

---

## 📸 See it in Action

<p align="center">
  <img src="docs/assets/devpost-gallery.png" alt="FeePass: the pool's lanes, one lane turning green, and a sample ticket" width="100%">
</p>

The picture is an illustration: it shows open lanes and a **sample** ticket, not a recorded transaction. Live: <https://feepass.edycu.dev> (the pool page is `/pool`).

## 💡 The Problem & Solution

### The Problem

A new user holds dollars (PUSD, a CashToken on Bitcoin Cash) and **no BCH**. Every transaction needs a miner fee paid in BCH, so they cannot move any of those dollars. Getting BCH first means an exchange detour, which is where new users give up.

### The Solution

A CashScript covenant, **the pool**, is designed to hold BCH in 20 UTXOs called lanes (the target; none is funded on mainnet yet). A send spends the user's PUSD coin **and one lane** in the same transaction. The lane pays the miner fee. The covenant requires that exactly **0.01 PUSD** comes back to the pool, so the user pays the fee in dollars and the pool earns that revenue in PUSD. The user's wallet signs only its own input, over WizardConnect.

What it does and does not promise:

- **No spendable BCH needed.** The wallet's non-token BCH balance does not have to move. (It is not "zero BCH": a token coin always carries a few hundred sats of dust.)
- **The fee is paid in dollars.** It is not free and not gasless: 0.01 PUSD per send.
- **The covenant does not pick the recipient.** The user's own `SIGHASH_ALL|FORKID|UTXOS` (0x61) signature binds the outputs, and only as far as the wallet shows them. See [What the covenant does not check](docs/ARCHITECTURE.md#what-the-covenant-does-not-check).

## 🏗️ Architecture & Tech Stack

<p align="center">
  <img src="docs/assets/architecture.svg" alt="The one transaction: in0 the user's PUSD coin, in1 one pool lane; out0 PUSD to the recipient, out1 PUSD change, out2 the lane back to the pool plus exactly 0.01 PUSD; the miner fee comes from the lane's BCH." width="100%">
</p>

| Layer | Choice | Where |
|---|---|---|
| Covenant | CashScript 0.14, 160-byte redeem script, 8 rules | [`contracts/FeePassPool.cash`](contracts/FeePassPool.cash) |
| Transaction builder | fixed shape, fee from the serialized size | [`src/core/sponsoredSend.ts`](src/core/sponsoredSend.ts) |
| Wallet link | WizardConnect (`@wizardconnect/dapp`, Vue adapter) | [`src/core/wizard.ts`](src/core/wizard.ts) |
| Chain access | Fulcrum over Electrum, **mainnet only** | [`src/core/config.ts`](src/core/config.ts) |
| App | Vue 3 + Vite + TypeScript, static | [`src/ui/`](src/ui/) |
| Starter PUSD | one serverless route (Vercel) | [`src/server/`](src/server/), [`api/feepass.mjs`](api/feepass.mjs) |

The covenant's eight rules, what each prevents, and the failure model are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Every claim there names the file that proves it.

### Security properties

| | Property | Enforced by |
|---|---|---|
| F1 | The sender pays the fee in dollars: exactly 0.01 PUSD returns to the pool (R5 is an equality, so no front end can overcharge through it) | covenant R5, `test/covenant.test.ts` |
| F2 | Concurrent senders do not collide: 20 lanes, a random open lane per send, re-sign on `txn-mempool-conflict` (at most 2 re-signs) | `src/core/lanes.ts`, `test/flow.test.ts` |
| F3 | Fixed transaction shape; the pool pays only the miner fee plus at most 675 sats of extras, and loses at most 2,000 sats per send | covenant R1, R4, R6 |
| F4 | The claim is "no spendable BCH", never "zero BCH" | copy in `src/ui/`, this file |
| F5 | The covenant does not bind the recipient; the user's own signature does | [ARCHITECTURE §1](docs/ARCHITECTURE.md#what-the-covenant-does-not-check) |

## ⛓️ Live Deployment

> **Status, stated plainly:** the app and the starter route are live at <https://feepass.edycu.dev>. The **mainnet pool is not funded yet**, so this repository contains **no pool address and no mainnet txid**, and the app shows "Pool not open yet" until a lane exists. This section is updated, with explorer links, when the operator tools first run on mainnet; every mainnet txid is then appended to `evidence/mainnet-txs.csv`.

What is verifiable today, all offline and reproducible with `npm test`:

| Evidence | File |
|---|---|
| Shape measured from the compiled artifact: 572 bytes, 580 sats miner fee at the standard 1 sat/B plus 8 bytes ECDSA headroom, 2,000 sats hard cap per send | [`evidence/tx-shape.json`](evidence/tx-shape.json) |
| WizardConnect round trip through the **real relay** with a headless conforming wallet: signed with sighash 0x61, accepted by the BCH VM (protocol-level; not a Selene or Paytaca result) | [`evidence/relay-roundtrip.json`](evidence/relay-roundtrip.json) |
| Covenant compile output | [`evidence/compile.json`](evidence/compile.json) |

Wallet compatibility is **unverified** for any named wallet until a human records it on the in-app `/gate.html` page.

## 📊 Engineering Rigor

| Metric | Value | Reproduce |
|---|---|---|
| Tests | **174 tests in 12 files** (vitest, offline; 173 run on a fresh clone, 1 checks the built bundle and runs after `npm run build`) | `npm test` |
| Type check | `vue-tsc --noEmit`, 0 errors | `npm run typecheck` |
| Mainnet guard | every provider in browser code is `'mainnet'`, asserted by a test | `test/mainnet-only.test.ts` |
| Pre-broadcast check | the signed transaction is verified on the BCH 2026 VM before it is sent | `verifySignedTx` in `src/core/` |

### Attacks defeated

| Control | Why it is load-bearing | Test |
|---|---|---|
| R5 equality on the pool's PUSD | a front end cannot undercharge or overcharge through the pool | `test/covenant.test.ts` |
| R8 `out1` carries PUSD | the top-up cannot leave as plain BCH in the same transaction | `test/covenant.test.ts` |
| R4 per-send cap (2,000 sats) | a hostile builder cannot drain a lane in one spend | `test/covenant.test.ts` |
| Starter claim must spend a real faucet output | a P2SH spend that only ends with the faucet key cannot fill the daily cap | `test/starter.test.ts` |
| Same user coin on every re-sign | two versions of one payment can never both confirm | `test/flow.test.ts` |

## 🚀 Getting Started

### Prerequisites

Node 22 or newer. No wallet, key or network setup is needed to run the tests.

### Installation

```bash
git clone https://github.com/edycutjong/feepass && cd feepass
npm install
npm test        # 174 tests (173 run before the first build), offline
npm run dev     # the app, reading Bitcoin Cash mainnet
```

### Try it with your own wallet (about 60 seconds)

1. Open <https://feepass.edycu.dev> and press **Connect wallet**; approve in a WizardConnect wallet.
2. No PUSD yet? Press **Get 0.25 starter PUSD** (one claim per address, 3 per UTC day; the starter faucet is not funded yet, check `/api/feepass?op=health`).
3. Enter a mainnet recipient and an amount, then **Send**. Approve the single signature request.
4. The ticket shows what was sent, the fee you paid in PUSD, the lane that paid the miner fee, and your spendable BCH before and after.

## 🧪 Testing & CI

```bash
npm test            # vitest, offline
npm run typecheck   # vue-tsc
npm run build       # bundles the API, type-checks, builds the static app
```

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: `npm ci`, a check that the compiled covenant artifact is up to date, `npm run typecheck`, `npm test` and `npx vite build`. (GitHub Actions is currently blocked by an account billing issue, so there is no CI badge.)

## 📁 Project Structure

```
contracts/FeePassPool.cash   the covenant
src/core/                    pure TypeScript: builder, send flow, lanes, config, starter
src/ui/                      the Vue app (send form, lane board, ticket)
src/server/ + api/           the one serverless route (starter PUSD, pool health)
scripts/                     operator tools: deploy, split into lanes, sweep, spike, measure
evidence/                    offline measurements (mainnet txids appear here later)
docs/                        ARCHITECTURE.md, DX-REPORT.md, assets/
test/                        12 test files
```

## 💰 Business Model

Wallets and merchants that onboard new users in PUSD want those users to transact on day one. The sender pays 0.01 PUSD per send; nobody pays a subscription. The public pool earns the spread: PUSD in, a little BCH out (per send at most 2,000 sats, 580 sats measured for the standard shape). A wallet can run its own lanes with the same MIT contract by changing constructor parameters, and keep its own fees. A cent per send is small money; the business is volume across wallets. A hosted-lanes service for wallets is unvalidated and not claimed.

## 📽️ Demo Materials

Live app: <https://feepass.edycu.dev> · How to reproduce every number: [DEMO.md](DEMO.md).

## 📄 License

[MIT](LICENSE).

## 🙏 Acknowledgments

Built **November 14–22, 2026** inside the BCH BLAZE 2026 coding window. Thanks to the Paytaca team for WizardConnect, the CashScript maintainers, and ParyonUSD. Community Choice CashTokens address: `bitcoincash:zpxrc4x4mzw7my37rwt5a2sx77vc0f84gvescta8a2`.
