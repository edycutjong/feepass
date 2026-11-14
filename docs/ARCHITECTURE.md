# FeePass architecture

FeePass lets a wallet that holds PUSD (ParyonUSD, a CashToken on Bitcoin Cash) but **no spendable BCH** send PUSD on mainnet.
> **Status (update this line when it changes):** the covenant, builder, flow, app and starter route are built and tested
> (`npm test`) and the app is live; the **mainnet pool is not deployed yet**, so there is no pool address or mainnet txid in this
> repo. `evidence/` holds offline measurements only; `evidence/mainnet-txs.csv` appears when the operator tools first run on
> mainnet. Wallet compatibility (does a given wallet sign this request) is unverified until a human records it via `/gate.html`.

A CashScript covenant ("the pool") pays the miner fee in sats; the sender pays for it in dollars: exactly `f` = 1 base unit
(0.01 PUSD) of PUSD goes to the pool. This file is written for a reader who will answer questions about the repo (human or
AI): every claim names the file that proves it.

## 1. The one transaction

```
in0   the user's PUSD coin        P2PKH, signed by the user's own wallet (SIGHASH_ALL|FORKID|UTXOS = 0x61)
in1   one pool lane               FeePassPool covenant UTXO, function sponsorPaid(), no signature
out0  PUSD → recipient            P2PKH with tokens
out1  PUSD change → user          P2PKH with tokens
out2  the lane, back to the pool  same covenant, minus the miner fee, plus exactly f PUSD
```

Nothing else is a valid spend of a lane except the operator's `withdraw(ownerSig)`. The covenant
(`contracts/FeePassPool.cash`, compiled to `src/contracts/`) enforces, in order:

| Rule | Check | What it prevents |
|---|---|---|
| R1 | 2 inputs, 3 outputs, covenant is input 1 | extra inputs/outputs that smuggle value out |
| R7 | `in1` carries PUSD | token-less lanes (every lane is seeded with PUSD) |
| R2 | `in0` and `out0` carry PUSD | a non-PUSD "send" |
| R8 | `out1` carries PUSD | the top-up leaving as plain BCH |
| R3 | `out2` locks to the same covenant | the lane walking away |
| R4 | `out2.value >= in1.value - C` (C = 2,000 sats) | draining more than a hard cap per tx |
| R5 | `out2.tokenAmount == in1.tokenAmount + f` (equality) | undercharging, and overcharging through any front end |
| R6 | `out0.value + out1.value <= in0.value + T` (T = 675 sats) | the lane funding more than one token dust of extras |

`sponsorPaid` takes no arguments: there is nothing to forge. The user's wallet signs only its own input; a wallet that itemizes
outputs will list the three before signing (unverified for any named wallet until the `/gate.html` check is recorded).

### What the covenant does NOT check

The pool constrains only what the pool pays and receives. It does **not** check: who `out0` pays or how much PUSD it carries
(only that it is PUSD), where `out1` (the change) goes, or the miner-fee level (it bounds only the lane's loss via R4 and the
extras via R6). Those outputs are bound by the user's own `SIGHASH_ALL|FORKID|UTXOS` signature on input 0, which commits to every
output. The pool does not "bind the recipient"; the user's signature does, and only to the extent the user sees what they sign: a
wallet that itemizes outputs lets them check; a wallet that does not (unverified, see the status line) cannot protect them from a
hostile front end, which could build a different send for the same coin. The app's `verifySignedTx` guards against a wallet
altering the built transaction, not against a malicious front end. PUSD conservation across `out0`+`out1` comes from CashTokens
consensus, not the covenant, and R6 lets those two outputs carry unrelated recipient sats. What no front end can do: make the
pool pay more than `C` or receive less than `f`. Constructor parameters (`ownerPk`, PUSD category, f, C, T) are in `src/config/mainnet.json`;
the pool address is derived from them in `src/core/pool.ts`, never typed.

Measured shape: 572 bytes, 580 sats miner fee at the standard 1 sat/B plus 8 bytes ECDSA headroom (`evidence/tx-shape.json`).

## 2. Where things live

```
contracts/FeePassPool.cash      the covenant (160-byte redeem script; sha256 of the artifact in mainnet.json)
src/core/                       pure TypeScript, no Vue, no DOM; the app and the tests call exactly these
  sponsoredSend.ts              buildSponsoredSend(): the fixed shape, fee from serialized size, top-up rules, usable-lane check
  lanes.ts                      buildBoard() / pickLane(): lane state from the live UTXO set, random open lane (F2)
  sendFlow.ts                   runSend(): pick lane → build → wallet signs → verify → broadcast → recover (see §3)
  wizard.ts                     WizardConnect request/response, verifySignedTx(): the BCH VM runs the signed tx before broadcast
  hdAddresses.ts, walletScan.ts addresses derived from the wallet's shared xpubs (gap 20, every path); PUSD + spendable BCH scan
  receipt.ts                    computeTicket(): every figure on the receipt is read from the transaction
  starter.ts                    the starter-PUSD faucet claim (§5)
  config.ts, params.ts          deployed configuration; refuses any network but mainnet
src/server/                     feepassApi.ts (routing, validation, error mapping) + function.ts (Electrum + env wiring)
api/feepass.mjs                 GENERATED bundle of src/server/function.ts (npm run build:api); this is what Vercel runs
src/ui/                         Vue 3 screens; useFeePass.ts is the app state; TicketCard.vue is the receipt
src/gate/                       /gate.html: a sign-only wallet-compatibility check (nothing broadcasts)
scripts/                        operator tools: compile, deploy, split (lanes), measurements, chipnet spike, relay round trip
test/                           vitest: covenant rules on the VM, builder, flow on a mock chain, UI, API, faucet
evidence/                       measured JSON/CSV the docs and the UI quote
```

## 3. A send, step by step (`src/core/sendFlow.ts`)

1. Read the user's PUSD coins (derived addresses) and the pool UTXOs from Fulcrum (mainnet only).
2. Pick a coin that carries `amount + f + 1` units (the 1 unit is change, R8) and a **random open lane** (F2: several judges
   clicking at once rarely collide). A lane is open while it holds at least `C` + its own token dust.
3. Build the fixed shape. The covenant input is built with its unlocker; the user input is a placeholder.
4. Send it to the wallet over WizardConnect for input 0 only.
5. **Verify before broadcasting** (`verifySignedTx`): same inputs and outputs and token amounts as proposed, input 0 signed
   with sighash `0x61`, fee at least 1 sat/B, and the full BCH VM accepts the signed transaction.
6. Broadcast. On `txn-mempool-conflict` (another send took the lane): exclude that lane, re-pick, ask for one more
   signature (at most 2 re-signs, then "Pool busy"). Every re-sign spends the **same** user coin, so two versions of one
   payment can never both confirm.
7. A pending-send record (localStorage, cross-tab lock, 30 min TTL) lets a reload resume: it asks the chain first, re-sends
   the same bytes if the network never saw them, never re-signs. "Status unknown" keeps the signed bytes.
8. The ticket re-reads the transaction: PUSD sent, fee paid, the actual pool subsidy (miner fee plus the top-up), the paid
   lane, and the spendable-BCH before and after. The "your BCH balance didn't change" line only appears when both snapshots were measured.

## 4. Mainnet guard

WizardConnect's handshake carries no network, and the app derives the wallet's addresses itself, so an address prefix proves
nothing. The guard is: the app's provider is `ElectrumNetworkProvider('mainnet')` with no switch; `parseConfig` throws for any
other network; recipients must be mainnet P2PKH (`parseRecipient` refuses test-network and script addresses); and a wallet whose
coins are not on mainnet simply shows "No PUSD found on mainnet" (never a network diagnosis). `test/mainnet-only.test.ts`
asserts every provider in browser code is `'mainnet'`.

## 5. Starter PUSD (the one server route)

A judge whose wallet holds no PUSD cannot make the required mainnet send, so one serverless function
(`api/feepass.mjs`, source `src/server/`) offers:

- `POST /api/feepass?op=starter` `{address}` → a 0.25 PUSD claim from a faucet key (`FAUCET_WIF`, a Vercel env var, never in the repo).
- `GET /api/feepass?op=health` → faucet PUSD and BCH, claims today, open lanes, whether the history read was truncated (answer cached 30 s per instance).

Guarantees are stated at their real strength. **One claim per receiving address and 3 claims per UTC day**, both read from the
faucet address's own on-chain history (a claim is any tx that spends a faucet coin, so the operator's own manual spends from the faucet key count too; a judge
returning PUSD to the faucet is not a claim). There is no database. The history read is not atomic, so two requests inside about a minute can both pass, bounded by the
claim size; a per-IP limit (3 per hour) lives in memory and is best effort. The hard budget is what the faucet holds. The
starter output carries at least twice the token dust, asserted before every broadcast, so the first send needs no top-up.
Concurrent claims pick a random faucet coin and retry on a coin conflict.

## 6. Trust and failure model

| Risk | Bound |
|---|---|
| Someone drains the pool | each tx costs the attacker `f` PUSD and the pool at most `C` sats (R4); lanes are small and refillable |
| Pool keeper's key leaks | the thief can sweep the pool (`withdraw`), never a user's coin; users' coins are never locked in the covenant |
| A fake front end | cannot move a coin without the user's signature and cannot change the pool's terms (`f`, `C`); whether the user can see what they sign depends on the wallet itemizing outputs (unverified) |
| Wallet refuses a mixed-input request | `/gate.html` records the result; not claimed compatible until a human verifies it |
| Faucet drained by fresh addresses | 3 claims per UTC day, small claim size, health route, daily top-up during judging |
| Pool empty / all lanes busy | named states in the UI ("Pool not open yet", "Pool refilling", "Pool busy"); nothing is signed |

## 7. Operating it

`scripts/split.ts` splits the operator wallet into N (20 is the target) lanes in one transaction, each seeded with 1 PUSD unit.
`scripts/sweep.ts` is the owner's `withdraw` path: it collects the pool's PUSD revenue and BCH to the operator wallet in one
transaction (`--closed` sweeps only closed lanes). **Refilling** a lane = sweep it, then split again: there is no separate refill
contract path.
Mainnet spends happen only with an explicit spending cap (`--authorized-cap`); every mainnet txid is appended to
`evidence/mainnet-txs.csv`. `npm test` runs offline (no network); `npm run build` regenerates the API bundle, type-checks, and
builds the static app.

## 8. What is not built, and why

The free tier (a server co-signature for demo sends) is not in the deployed contract: its per-address limit could not be made
atomic. The payee-funded fee variant is a fallback that is built only if wallets refuse the mixed-input request. The pool
page and receipt never show a number that is not read from the chain or from `evidence/`.
