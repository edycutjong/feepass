<script setup lang="ts">
// S3: recipient + amount, validated before anything is built. The three-output preview is rendered from a BUILT transaction,
// so its amounts are the ones the wallet prompt can show (out2 = the lane's own PUSD + the fee).
import { computed, ref } from 'vue';
import type { Contract } from 'cashscript';
import { formatUnits, parseRecipient, parseUnits, shortAddress } from '../core/amounts';
import type { AppConfig } from '../core/config';
import type { Board } from '../core/lanes';
import { buildSponsoredSend } from '../core/sponsoredSend';
import { candidateCoins, type WalletScan } from '../core/walletScan';

const props = defineProps<{ cfg: AppConfig; wallet: WalletScan; board: Board | null; pool: Contract<any, any, 'p2sh32'>; maxUnits: bigint; busy: boolean }>();
const emit = defineEmits<{ send: [recipient: string, amount: bigint] }>();

const to = ref('');
const amount = ref('');
const touched = ref(false);
const fee = computed(() => formatUnits(props.cfg.params.feeTokens, props.cfg.decimals));

const r = computed(() => parseRecipient(to.value));
const a = computed(() => parseUnits(amount.value, props.cfg.decimals));
const amountError = computed(() => {
  if (!a.value.ok) return a.value.reason;
  if (a.value.value > props.maxUnits)
    return props.maxUnits > 0n
      ? `Amount exceeds what your largest PUSD coin can carry: at most ${formatUnits(props.maxUnits)} PUSD (it also pays the ${fee.value} PUSD fee and keeps 0.01 PUSD change).`
      : `Your PUSD coins are too small to carry a send plus the ${fee.value} PUSD fee and 0.01 PUSD change.`;
  return '';
});

const preview = computed(() => {
  if (!r.value.ok || !a.value.ok || amountError.value) return null;
  const lane = props.board?.lanes.find((l) => l.state === 'open');
  if (!lane) return null;
  const amt = a.value.value;
  let lastErr = '';
  for (const c of candidateCoins(props.wallet.coins, amt, props.cfg.params)) {
    try {
      const s = buildSponsoredSend({ pool: props.pool, params: props.cfg.params, categoryDisplay: props.cfg.categoryDisplay, userUtxo: c, userAddress: c.owner.tokenAddress, lane: lane.utxo, recipient: r.value.value, amount: amt });
      return { ok: true as const, send: amt, change: s.outputs.changeUnits, lane: s.outputs.laneUnits, subsidy: s.poolSubsidySats };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { ok: false as const, reason: lastErr };
});

const canSend = computed(() => r.value.ok && a.value.ok && !amountError.value && !props.busy && !!props.board?.open && preview.value?.ok !== false);

function preset() {
  to.value = props.cfg.demoRecipient;
  amount.value = formatUnits(props.cfg.demoAmountUnits, props.cfg.decimals);
  touched.value = true;
}
function max() {
  amount.value = formatUnits(props.maxUnits, props.cfg.decimals);
  touched.value = true;
}
function submit() {
  touched.value = true;
  if (canSend.value && r.value.ok && a.value.ok) emit('send', r.value.value, a.value.value);
}
</script>

<template>
  <form class="panel send" novalidate @submit.prevent="submit">
    <h2>Send PUSD</h2>
    <label for="to">To</label>
    <input id="to" v-model="to" class="data" autocomplete="off" spellcheck="false" placeholder="bitcoincash:q… or z…"
      :aria-invalid="touched && !!to && !r.ok" aria-describedby="to-err" @blur="touched = true" />
    <p id="to-err" class="err" v-if="touched && to && !r.ok">✕ {{ r.reason }}</p>
    <button type="button" class="linkbtn" data-testid="preset" @click="preset">
      Send {{ formatUnits(cfg.demoAmountUnits) }} PUSD back to the FeePass faucet
    </button>

    <label for="amt">Amount</label>
    <div class="amt">
      <input id="amt" v-model="amount" class="data" inputmode="decimal" autocomplete="off" placeholder="1.00"
        :aria-invalid="touched && !!amount && !!amountError" aria-describedby="amt-err" @blur="touched = true" />
      <span class="unit">PUSD</span>
      <button type="button" class="btn ghost small" :disabled="maxUnits <= 0n" @click="max">Max</button>
    </div>
    <p id="amt-err" class="err" v-if="touched && amount && amountError">✕ {{ amountError }}</p>

    <dl class="costs">
      <div><dt>You pay</dt><dd class="data">{{ a.ok ? formatUnits(a.value) : '—' }} PUSD + {{ fee }} PUSD fee</dd></div>
      <div><dt>Network fee</dt><dd>covered by the pool<span v-if="preview?.ok" class="data muted"> ({{ preview.subsidy }} sats)</span></dd></div>
    </dl>

    <p v-if="preview?.ok" class="outputs" data-testid="wallet-outputs">
      This transaction has 3 outputs (a wallet that itemizes them will show):
      <span class="data">{{ formatUnits(preview.send) }}</span> → {{ shortAddress(r.ok ? r.value : '') }} ·
      <span class="data">{{ formatUnits(preview.change) }}</span> → you ·
      <span class="data">{{ formatUnits(preview.lane) }}</span> → the pool (the lane's own PUSD plus your {{ fee }} fee; only {{ fee }} of it is yours).
    </p>
    <p v-else-if="preview && !preview.ok" class="err">✕ {{ preview.reason }}</p>
    <p v-else-if="board && !board.open" class="err">✕ {{ board.lanes.length === 0 ? 'Pool not open yet: no funded lanes at the covenant address.' : 'All lanes are closed right now: the pool needs refilling.' }}</p>

    <button type="submit" class="btn go" :disabled="!canSend" data-testid="send">
      {{ busy ? 'Waiting…' : a.ok && !amountError ? `Send ${formatUnits(a.value)} PUSD` : 'Send' }}
    </button>
  </form>
</template>

<style scoped>
label { display: block; font-weight: 600; margin: 14px 0 6px; }
input { width: 100%; min-height: 48px; padding: 10px 12px; border: 2px solid var(--rule); border-radius: 6px; background: #fff; color: var(--ink);
  transition: border-color .14s var(--ease); }
input:hover { border-color: var(--muted); }
input:focus { border-color: var(--ink); outline: none; }
input:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
input[aria-invalid='true'] { border-color: var(--before); }
.amt { display: flex; align-items: center; gap: 10px; }
.amt input { flex: 1; font-size: 22px; }
.unit { font: 800 18px/1 var(--font-display); }
.err { margin: 6px 0 0; color: var(--ink); }
.err::first-letter { color: var(--before); }
.costs { margin: 16px 0 8px; display: grid; gap: 4px; }
.costs div { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.costs dt { color: var(--muted); }
.costs dd { margin: 0; }
.outputs { font-size: 15px; color: var(--muted); border-left: 3px solid var(--rule); padding-left: 10px; }
.go { width: 100%; margin-top: 14px; font-size: 22px; min-height: 56px; }
</style>
