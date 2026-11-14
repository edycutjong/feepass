<script setup lang="ts">
// Wallet-compatibility gate (F6). Connect a wallet over WizardConnect, find a real PUSD coin on mainnet, ask the wallet
// to sign shape (a) and shape (b), check what comes back, and produce a report to paste into the gate record.
import { computed, onMounted, ref, watch } from 'vue';
import { useWizardConnect, WizardConnectQRDialog } from '@paytaca/wizardconnect-vue';
import { ElectrumNetworkProvider, type SpendableUtxo } from 'cashscript';
import { deriveAddresses, type DerivedAddress } from '../core/hdAddresses';
import { verifySignedTx } from '../core/wizard';
import { lockingBytecodeOf } from '../core/dust';
import { shapeA, shapeB, type ShapeRequest } from './shapes';
import gate from '../config/gate.json';

const wc = useWizardConnect({ dappName: 'FeePass wallet check', persistSession: false });
const showQr = ref(false);
const provider = new ElectrumNetworkProvider('mainnet');

const height = ref<number | null>(null);
const heightError = ref('');
onMounted(async () => {
  try { height.value = await provider.getBlockHeight(); } catch (e) { heightError.value = (e as Error).message; }
});

const addresses = ref<DerivedAddress[]>([]);
const coins = ref<(SpendableUtxo & { owner: DerivedAddress })[]>([]);
const scanning = ref(false);
const scanError = ref('');
const spendableBch = ref<bigint | null>(null);
type Result = { id: number; shape: string; synthetic: boolean; outcome: 'signed-verified' | 'signed-rejected-by-check' | 'refused-by-wallet' | 'error'; detail: string; sighash?: string; txid?: string; at: string };
const results = ref<Result[]>([]);
const busy = ref('');

const connected = computed(() => wc.state.value === 'connected');
watch(() => wc.state.value, async (s) => {
  if (s === 'connected') { showQr.value = false; await scan(); }
});

function connect() {
  if (wc.connect()) showQr.value = true;
}

async function scan() {
  const m = wc.manager.value;
  if (!m) return;
  scanning.value = true; scanError.value = '';
  try {
    const paths = m.getSessionPaths();
    addresses.value = deriveAddresses(paths);
    const found: typeof coins.value = [];
    let bch = 0n;
    await Promise.all(addresses.value.map(async (a) => {
      const utxos = await provider.getUtxos(a.address);
      for (const u of utxos) {
        if (!u.token) bch += u.satoshis;
        else if (u.token.category === gate.categoryDisplay && !u.token.nft) found.push({ ...u, owner: a });
      }
    }));
    spendableBch.value = bch;
    coins.value = found.sort((x, y) => Number(y.token!.amount - x.token!.amount));
    if (found.length === 0) scanError.value = 'No PUSD found on mainnet in the addresses this wallet shared.';
  } catch (e) {
    scanError.value = (e as Error).message;
  } finally {
    scanning.value = false;
  }
}

let seq = 0;

/** Use the first PUSD coin the builder can actually spend in this shape (largest first), so one unusable coin does not
 *  end the human's signing session before the wallet is even asked. */
function firstBuildable(which: 'a' | 'b') {
  let lastError = 'No PUSD coin found';
  for (const coin of coins.value) {
    const owner = { tokenAddress: coin.owner.tokenAddress, pathName: coin.owner.pathName, addressIndex: coin.owner.addressIndex };
    try {
      return { coin, owner, shape: which === 'a' ? shapeA(provider, coin, owner) : shapeB(provider, coin, owner) };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(`None of your PUSD coins fits this shape: ${lastError}`);
}

async function run(which: 'a' | 'b') {
  const m = wc.manager.value;
  if (!m || coins.value.length === 0) return;
  busy.value = which;
  let shape: ShapeRequest | undefined;
  const at = new Date().toISOString();
  try {
    const picked = firstBuildable(which);
    shape = picked.shape;
    const owner = picked.owner;
    const res = await m.signTransaction({ transaction: shape.request.wire as never, inputPaths: shape.request.inputPaths });
    if (res.error || !res.signedTransaction) {
      results.value.unshift({ id: ++seq, shape: shape.describe, synthetic: shape.synthetic, outcome: 'refused-by-wallet', detail: res.error ?? 'empty response', at });
      return;
    }
    try {
      const v = verifySignedTx(res.signedTransaction, shape.request.proposed, lockingBytecodeOf(owner.tokenAddress));
      results.value.unshift({ id: ++seq, shape: shape.describe, synthetic: shape.synthetic, outcome: 'signed-verified', detail: `${v.sizeBytes} B, fee ${v.feeSats} sats`, sighash: '0x' + v.sighashType.toString(16), txid: v.txid, at });
    } catch (e) {
      results.value.unshift({ id: ++seq, shape: shape.describe, synthetic: shape.synthetic, outcome: 'signed-rejected-by-check', detail: (e as Error).message, at });
    }
  } catch (e) {
    results.value.unshift({ id: ++seq, shape: shape?.describe ?? `(${which})`, synthetic: shape?.synthetic ?? true, outcome: 'error', detail: (e as Error).message, at });
  } finally {
    busy.value = '';
  }
}

const report = computed(() => JSON.stringify({
  page: 'FeePass wallet check (F6)',
  walletName: wc.walletName.value,
  walletVersionFromAboutScreen: '<fill in by hand>',
  sharedPaths: wc.manager.value?.getSessionPaths().map((p) => p.name) ?? [],
  pusdCoins: coins.value.map((c) => ({ outpoint: `${c.txid}:${c.vout}`, sats: String(c.satoshis), units: String(c.token!.amount), path: `${c.owner.pathName}/${c.owner.addressIndex}` })),
  spendableBchSats: spendableBch.value === null ? null : String(spendableBch.value),
  laneConfigured: gate.lane !== null,
  results: results.value,
}, null, 2));

async function copyReport() { await navigator.clipboard.writeText(report.value); }
</script>

<template>
  <main class="gate">
    <header>
      <p class="eyebrow">FeePass · wallet compatibility check</p>
      <h1>Will your wallet sign a FeePass send?</h1>
      <p class="lede">Nothing here moves money. The wallet is asked to <strong>sign only</strong> (no broadcast); this page checks the
        signature and prints a report. Mainnet only.</p>
      <p class="status" data-testid="mainnet-status">
        <template v-if="height">BCH mainnet reachable · block {{ height.toLocaleString('en-US') }}</template>
        <template v-else-if="heightError"><span class="err">Mainnet server unreachable: {{ heightError }}</span></template>
        <template v-else>Connecting to BCH mainnet…</template>
      </p>
    </header>

    <section class="card">
      <h2>1 · Connect</h2>
      <p v-if="!connected">Open Selene or Paytaca → WizardConnect → scan.</p>
      <p v-else>Connected: <strong>{{ wc.walletName.value ?? 'wallet' }}</strong> · {{ addresses.length }} addresses derived from {{ wc.manager.value?.getSessionPaths().length }} shared paths</p>
      <button v-if="!connected" type="button" @click="connect">Connect wallet</button>
      <button v-else type="button" class="ghost" @click="wc.disconnect()">Disconnect</button>
      <p v-if="wc.error.value" class="err">{{ wc.error.value }}</p>
    </section>

    <section class="card" v-if="connected">
      <h2>2 · Your PUSD on mainnet</h2>
      <p v-if="scanning">Reading mainnet…</p>
      <p v-else-if="scanError" class="err">{{ scanError }}</p>
      <ul v-else class="coins">
        <li v-for="c in coins" :key="c.txid + c.vout">{{ (Number(c.token!.amount) / 100).toFixed(2) }} PUSD · {{ c.satoshis }} sats · {{ c.owner.pathName }}/{{ c.owner.addressIndex }}</li>
      </ul>
      <p v-if="spendableBch !== null">Spendable BCH (non-token coins): {{ spendableBch }} sats</p>
      <button type="button" class="ghost" @click="scan" :disabled="scanning">Rescan</button>
    </section>

    <section class="card" v-if="connected && coins.length">
      <h2>3 · Ask the wallet to sign</h2>
      <p v-if="!gate.lane" class="note">No mainnet pool lane is deployed yet, so shape (a) uses a placeholder lane: a <strong>sign-only
        pre-check</strong>. It tells us whether the wallet will sign; it is not the final mainnet verdict.</p>
      <div class="row">
        <button type="button" :disabled="!!busy" @click="run('a')">{{ busy === 'a' ? 'Waiting for wallet…' : 'Shape (a): covenant input' }}</button>
        <button type="button" :disabled="!!busy" @click="run('b')">{{ busy === 'b' ? 'Waiting for wallet…' : 'Shape (b): merchant input' }}</button>
      </div>
      <ol class="results">
        <li v-for="r in results" :key="r.id" :class="r.outcome">
          <strong>{{ r.outcome }}</strong> — {{ r.shape }}<span v-if="r.synthetic"> (pre-check)</span><br />
          <small>{{ r.detail }}<span v-if="r.sighash"> · sighash {{ r.sighash }}</span></small>
        </li>
      </ol>
    </section>

    <section class="card" v-if="results.length">
      <h2>4 · Report</h2>
      <pre>{{ report }}</pre>
      <button type="button" @click="copyReport">Copy report</button>
    </section>

    <WizardConnectQRDialog v-if="wc.uri.value && wc.qrUri.value" :show="showQr" :on-close="() => (showQr = false)"
      :uri="wc.uri.value" :qr-uri="wc.qrUri.value" title="Connect a BCH wallet" subtitle="Scan with Selene or Paytaca (WizardConnect)" />
  </main>
</template>

<style>
:root { --ink: #14213d; --sign: #1f4f9a; --paper: #f6f4ee; --line: #d8d3c4; --ok: #1d7a46; --bad: #a3271f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
.gate { max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--sign); margin: 0; }
h1 { font-size: 1.9rem; line-height: 1.15; margin: .3rem 0 .6rem; }
.lede { margin: 0 0 .5rem; }
.status { font: .85rem/1.4 ui-monospace, monospace; color: #475569; margin: 0 0 1.5rem; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.2rem; margin-bottom: 1rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
button { font: inherit; background: var(--sign); color: #fff; border: 0; border-radius: 8px; padding: .55rem 1rem; cursor: pointer; transition: transform .12s ease, opacity .12s ease; }
button:hover:not(:disabled) { transform: translateY(-1px); }
button:active:not(:disabled) { transform: translateY(0); opacity: .9; }
button:focus-visible { outline: 3px solid #f2b705; outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
button.ghost { background: transparent; color: var(--sign); border: 1px solid var(--sign); }
.row { display: flex; gap: .6rem; flex-wrap: wrap; }
.err { color: var(--bad); }
.note { background: #fff8e1; border-left: 3px solid #f2b705; padding: .5rem .7rem; }
.results li { margin: .5rem 0; }
.results .signed-verified strong { color: var(--ok); }
.results .refused-by-wallet strong, .results .signed-rejected-by-check strong, .results .error strong { color: var(--bad); }
pre { background: #0f172a; color: #e2e8f0; padding: .8rem; border-radius: 8px; overflow: auto; font-size: .78rem; max-height: 22rem; }
</style>
