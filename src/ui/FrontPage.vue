<script setup lang="ts">
// The disconnected front screen: headline + the sample booth, measured receipts, the live lane board, the covenant's own rules,
// what FeePass does not promise, and the questions people ask. Figures come from evidence/tx-shape.json and the mainnet config;
// pool status comes from the live board.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { measured } from '../core/evidence';
import type { Board } from '../core/lanes';
import LaneBoard from './LaneBoard.vue';
import SampleBooth from './SampleBooth.vue';

const props = defineProps<{ fee: string; board: Board | null; error: string; slots: number; repoUrl: string }>();
defineEmits<{ connect: [] }>();

const std = measured.send;
const fmt = (n: number) => n.toLocaleString('en-US');
/** n = a count-up target; text = a fixed figure (the fee is a decimal amount, not a count). */
const receipts = computed(() => [
  { n: null, text: props.fee, unit: 'PUSD', label: 'the only fee you pay, in the same transaction', proof: 'src/config/mainnet.json' },
  { n: std.minerFeeSats, text: '', unit: 'sats', label: 'miner fee of a standard send, paid by the lane', proof: 'evidence/tx-shape.json' },
  { n: measured.maxSubsidySats, text: '', unit: 'sats', label: 'the most one lane can lose in one send', proof: 'src/config/mainnet.json' },
  { n: std.signedSizeBytes, text: '', unit: 'bytes', label: 'a standard send: 2 inputs, 3 outputs (Schnorr signature)', proof: 'evidence/tx-shape.json' },
]);
const contractUrl = computed(() => `${props.repoUrl}/blob/main/contracts/FeePassPool.cash`);
const blob = (path: string) => `${props.repoUrl}/blob/main/${path}`;

const lanesFunded = computed(() => props.board?.lanes.length ?? 0);
const poolUnfunded = computed(() => !!props.board && lanesFunded.value === 0);

// Count-ups: the text already holds the final number (print, screenshots, no motion); the animation only runs from 0 when the
// receipt strip scrolls into view and the user has not asked for reduced motion.
const k = ref(1);
const shown = (n: number) => fmt(Math.round(n * k.value));
const strip = ref<HTMLElement | null>(null);
let io: IntersectionObserver | undefined;
let raf = 0;
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches || !strip.value) return;
  io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io?.disconnect();
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1100);
      k.value = 1 - Math.pow(1 - p, 3);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    k.value = 0;
    raf = requestAnimationFrame(tick);
  }, { threshold: 0.4 });
  io.observe(strip.value);
});
onBeforeUnmount(() => { io?.disconnect(); cancelAnimationFrame(raf); });
</script>

<template>
  <main class="front">
    <section class="hero wide">
      <h1 class="display headline"><span class="l1">The lane <span class="plate-word">pays the fee.</span></span>
        <span class="l2">You pay a cent.</span></h1>
      <SampleBooth class="booth-slot" :fee="fee" />
      <p class="plain">Send dollars on Bitcoin Cash with no spendable BCH.</p>
      <div class="copy">
        <p class="sub">A pool lane pays the <strong class="data">{{ std.minerFeeSats }} sats</strong> miner fee and the covenant takes back exactly
          <strong class="data">{{ fee }} PUSD</strong>, in the same transaction. Your wallet signs only its own coin.</p>
        <div class="ctas">
          <button type="button" class="btn big" data-testid="hero-connect" @click="$emit('connect')">Connect wallet</button>
          <a class="btn big ghost" href="/deck/">Pitch deck</a>
        </div>
        <p class="status" :class="{ closed: poolUnfunded }" data-testid="front-status">
          <template v-if="error">Pool status unavailable right now. You can still connect and see your balances.</template>
          <template v-else-if="!board">Reading the pool from mainnet…</template>
          <template v-else-if="poolUnfunded"><strong>The pool is not open yet.</strong> You can connect and see your balances; sends start once lanes are funded.</template>
          <template v-else><strong>{{ board.open }} of {{ lanesFunded }} lanes open.</strong> Connect a WizardConnect wallet that holds PUSD and send.</template>
        </p>
      </div>
    </section>

    <section ref="strip" class="receipts" aria-label="Measured figures">
      <div class="wide grid">
        <div v-for="r in receipts" :key="r.label" class="receipt">
          <p class="fig"><span class="display num" data-testid="receipt-num">{{ r.n === null ? r.text : shown(r.n) }}</span> <span class="unit display">{{ r.unit }}</span></p>
          <p class="lbl">{{ r.label }}</p>
          <a class="proof data" :href="blob(r.proof)" target="_blank" rel="noopener">{{ r.proof }}</a>
        </div>
      </div>
    </section>

    <section class="live wide" aria-labelledby="live-h">
      <div class="live-head">
        <h2 id="live-h" class="display">The pool, live from mainnet</h2>
        <p class="muted">Each signal head is one pool lane, read from a mainnet server: <strong>↓</strong> open, <strong>✕</strong> below the
          {{ fmt(measured.maxSubsidySats) }}-sat per-send cap plus the lane's own dust, so the app will not pick it. Unlit heads mean there is no lane to
          show: the pool is not funded, the read is still loading, or the read failed. A send takes one open lane at random.</p>
      </div>
      <LaneBoard :board="board" :error="error" :active="null" :chosen="null" :slots="slots" large />
      <p class="small"><a href="/pool">Open the pool page</a> for the covenant address and every lane's balance.</p>
    </section>

    <section class="mech wide" aria-labelledby="mech-h">
      <h2 id="mech-h" class="display">One transaction. Two inputs, three outputs.</h2>
      <div class="tx" role="img" aria-label="Inputs: your PUSD coin signed by your wallet, and one pool lane unlocked by the covenant. Outputs: PUSD to the recipient, PUSD change to you, and the lane back to the pool minus the miner fee plus exactly the PUSD fee.">
        <div class="col">
          <p class="colh display">Inputs</p>
          <p class="io"><span class="ix data">in0</span><span><strong>your PUSD coin</strong><small>signed by your wallet</small></span></p>
          <p class="io"><span class="ix data">in1</span><span><strong>one pool lane</strong><small>unlocked by the covenant, no key</small></span></p>
        </div>
        <div class="mid"><span class="display">→</span><small class="data">{{ std.signedSizeBytes }} bytes</small></div>
        <div class="col">
          <p class="colh display">Outputs</p>
          <p class="io"><span class="ix data">out0</span><span><strong>PUSD → recipient</strong><small>who and how much: your choice</small></span></p>
          <p class="io"><span class="ix data">out1</span><span><strong>PUSD change → you</strong></span></p>
          <p class="io"><span class="ix data">out2</span><span><strong>lane → pool</strong><small>minus the miner fee, plus exactly {{ fee }} PUSD</small></span></p>
        </div>
      </div>

      <div class="rules">
        <article class="rule r5">
          <h3 class="display">Exactly {{ fee }} PUSD back</h3>
          <p>An equality, never a minimum: no front end can charge you more or less through the pool.</p>
          <div class="ledger" aria-label="The lane's PUSD before and after one send">
            <p><span class="k">in1</span><span>lane holds</span><b>n PUSD</b></p>
            <p><span class="k">out2</span><span>lane returns</span><b>n <span class="plus">+ {{ fee }}</span> PUSD</b></p>
          </div>
          <pre class="code"><code>require(tx.outputs[2].tokenAmount ==
        tx.inputs[1].tokenAmount + feeTokens);</code></pre>
        </article>
        <article class="rule">
          <h3 class="display">Capped per send</h3>
          <p>A lane can lose at most {{ fmt(measured.maxSubsidySats) }} sats in one transaction.</p>
          <pre class="code"><code>require(tx.outputs[2].value >=
        tx.inputs[1].value - maxSubsidy);</code></pre>
        </article>
        <article class="rule">
          <h3 class="display">One fixed shape</h3>
          <p>Two inputs, three outputs, the lane at input 1. The only other way to spend a lane is the operator's key.</p>
          <pre class="code"><code>require(tx.inputs.length == 2);
require(tx.outputs.length == 3);</code></pre>
        </article>
        <article class="rule retry">
          <h3 class="display">Random lane, same coin</h3>
          <p>If another send takes your lane first, FeePass picks a new one and asks your wallet to sign again with the <em>same</em> coin
            (up to two re-signs), so only one version of your payment can ever confirm.</p>
          <a class="small" :href="contractUrl" target="_blank" rel="noopener">Read the covenant source</a>
        </article>
      </div>
    </section>

    <section class="honest" aria-labelledby="honest-h">
      <div class="wide">
        <h2 id="honest-h" class="display">What it does not promise</h2>
        <ul>
          <li><strong>Not "zero BCH".</strong> A token coin always carries a few hundred sats of dust. What FeePass needs is no <em>spendable</em> BCH.</li>
          <li><strong>Not free, not gasless.</strong> You pay {{ fee }} PUSD per send. That is the fee, and the pool's revenue.</li>
          <li><strong>Not the recipient's guard.</strong> The covenant does not check who gets paid. Your own signature covers the outputs, as far as your wallet shows them.</li>
          <li><strong>Not a mainnet receipt.</strong> The ticket above is a sample: its figures are computed offline from the compiled covenant.<span
            v-if="poolUnfunded" data-testid="honest-pool"> The mainnet pool is not funded yet.</span></li>
          <li><strong>Not bounded in total.</strong> The covenant caps what each send can take from a lane; many sends can still use lanes up, and the operator refills them.</li>
          <li><strong>Not verified on a named wallet yet.</strong> Wallet results are recorded on the <a href="/gate.html">wallet gate page</a> by a person holding the wallet.</li>
        </ul>
      </div>
    </section>

    <section class="faq wide" aria-labelledby="faq-h">
      <h2 id="faq-h" class="display">Fair questions</h2>
      <details>
        <summary>Is it free?</summary>
        <p>No. You pay {{ fee }} PUSD per send, inside the same transaction, to the pool. The pool's lane pays the miner fee in BCH:
          {{ std.minerFeeSats }} sats for a standard send.</p>
      </details>
      <details>
        <summary>Does my wallet need any BCH?</summary>
        <p>No spendable BCH. Your PUSD coin carries its own few hundred sats, like every token coin. After a real send, the ticket prints
          your spendable BCH before and after, read from the chain.</p>
      </details>
      <details>
        <summary>Who decides where the money goes?</summary>
        <p>You, in your wallet. Your signature (sighash 0x61, SIGHASH_ALL with UTXOS) covers every output. The covenant only checks the
          pool's side: the lane comes back with exactly {{ fee }} PUSD more and at most {{ fmt(measured.maxSubsidySats) }} sats less.</p>
      </details>
      <details>
        <summary>What stops someone from draining the pool?</summary>
        <p>A send costs a lane its miner fee: {{ std.minerFeeSats }} sats for a standard send, {{ measured.maxMeasuredSubsidySats }} sats when the
          lane also tops up a small coin's dust, and never more than {{ fmt(measured.maxSubsidySats) }} sats. Every send pays the pool exactly
          {{ fee }} PUSD. The covenant bounds each send, not the total: many sends can still use lanes up, and a lane that runs low closes
          (✕) until the operator refills it. Lanes are separate coins, so one send touches one lane.</p>
      </details>
      <details>
        <summary>Which wallets work?</summary>
        <p>Wallets that connect over WizardConnect. The handshake carries no network, so FeePass checks mainnet itself. No named wallet is
          verified yet; results go on the <a href="/gate.html">wallet gate page</a>.</p>
      </details>
      <details>
        <summary>Is this really mainnet?</summary>
        <p>Yes: mainnet is the only network it uses. The header shows the live block height, and every chain read uses a mainnet server.
          <template v-if="poolUnfunded">The pool's lanes are not funded yet, so sends wait for the pool to open.</template>
          <template v-else-if="board">{{ board.open }} of {{ lanesFunded }} lanes are open right now.</template>
          <template v-else>The pool status is still loading.</template></p>
      </details>
    </section>
  </main>
</template>

<style scoped>
.front { overflow-x: clip; }
.wide { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
.hero { display: grid; grid-template-columns: minmax(0, .84fr) minmax(0, 1.16fr); grid-template-areas: "h booth" "plain booth" "copy booth";
  column-gap: 56px; row-gap: 22px; padding-top: 48px; padding-bottom: 48px; }
.headline { grid-area: h; align-self: end; margin-top: 4px; font-size: clamp(38px, 4.3vw, 60px); line-height: 1; letter-spacing: 0; }
.headline .l1, .headline .l2 { display: block; animation: rise .6s var(--ease) both; }
.headline .l2 { animation-delay: .12s; }
.booth-slot { grid-area: booth; align-self: center; }
.copy { grid-area: copy; align-self: start; }
.plate-word { display: inline-block; white-space: nowrap; background: var(--sign); color: var(--sign-ink); padding: .06em .2em .02em; margin: .04em 0; border-radius: .12em;
  box-shadow: inset 0 0 0 .05em var(--sign), inset 0 0 0 .085em rgba(255, 255, 255, .92); }
.plain { grid-area: plain; font-size: 23px; line-height: 1.35; font-weight: 600; margin: 0; max-width: 26em; }
.sub { font-size: 19px; max-width: 32em; margin: 0 0 24px; animation: rise .6s var(--ease) .22s both; }
.sub strong.data { font-size: .95em; white-space: nowrap; }
.ctas { display: flex; flex-wrap: wrap; gap: 12px; animation: rise .6s var(--ease) .32s both; }
.ctas a.btn { display: inline-flex; align-items: center; text-decoration: none; padding: 0 28px; margin: 0; }
.big { min-height: 58px; font-size: 22px; padding: 0 28px; }
.status { font-size: 16px; line-height: 1.45; margin: 18px 0 0; padding-left: 14px; border-left: 4px solid var(--rule); max-width: 32em; }
.status.closed { border-left-color: var(--before); }
/* transform only: the headline and lede paint on the first frame (no opacity fade delaying the largest paint) */
@keyframes rise { from { transform: translateY(12px); } to { transform: none; } }

.receipts { background: var(--paper); border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.receipts .grid { display: grid; grid-template-columns: repeat(4, 1fr); }
.receipt { padding: 28px 22px 24px; border-left: 2px dashed var(--rule); }
.receipt:first-child { border-left: 0; padding-left: 0; }
.fig { margin: 0; line-height: 1; white-space: nowrap; }
.num { font-size: 56px; }
.unit { font-size: 22px; color: var(--muted); }
.lbl { margin: 10px 0 8px; font-size: 16px; line-height: 1.4; }
.proof { font-size: 12px; color: var(--muted); }
.proof:hover { color: var(--ink); }

.live { padding-top: 64px; }
.live-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; align-items: end; margin-bottom: 18px; }
.live-head p { margin: 0; }
.live :deep(.large .heads) { grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 8px; }
h2.display { font-size: clamp(32px, 4vw, 48px); }
.small { font-size: 15px; }

.mech { padding-top: 72px; }
.tx { display: grid; grid-template-columns: 1fr auto 1fr; gap: 24px; align-items: center; background: var(--paper); border: 1px solid var(--rule);
  border-radius: 10px; padding: 26px 28px; margin: 24px 0 18px; }
.colh { font-size: 20px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); }
.io { display: grid; grid-template-columns: 3.4em 1fr; gap: 10px; margin: 0; padding: 9px 0; border-bottom: 1px dotted var(--rule); }
.io small { display: block; color: var(--muted); font-size: 14px; }
.ix { font-size: 13px; color: var(--muted); padding-top: 3px; }
.mid { display: grid; justify-items: center; gap: 4px; }
.mid .display { font-size: 44px; color: var(--sign); }
.mid small { font-size: 12px; color: var(--muted); }
.rules { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.rule { background: var(--paper); border: 1px solid var(--rule); border-radius: 10px; padding: 20px 22px; display: grid; align-content: start; gap: 8px;
  transition: transform .16s var(--ease), border-color .16s var(--ease); }
.rule:hover { transform: translateY(-2px); border-color: var(--ink); }
.rule h3 { font-size: 24px; }
.rule p { margin: 0; font-size: 16px; }
.r5 { grid-row: span 2; border-top: 6px solid var(--sign); }
.retry { grid-column: span 2; }
.ledger { margin: 8px 0 4px; display: grid; gap: 0; font: 400 15px/1.3 var(--font-data); }
.ledger p { display: grid; grid-template-columns: 4em 1fr auto; gap: 10px; margin: 0; padding: 10px 0; border-bottom: 1px dotted var(--rule); }
.ledger .k { color: var(--muted); }
.ledger b { font-weight: 600; }
.ledger .plus { color: var(--sign); }
.code { margin: 6px 0 0; background: var(--housing); color: var(--rule); border-radius: 6px; padding: 12px 14px;
  font: 400 13px/1.55 var(--font-data); white-space: pre-wrap; overflow-wrap: anywhere; }

.honest { background: var(--housing); color: var(--rule); margin-top: 72px; padding: 56px 0 50px; }
.honest h2 { color: var(--paper); }
.honest a { color: var(--paper); }
.honest a:hover { color: var(--sign-ink); }
.honest strong { color: var(--sign-ink); }
.honest ul { list-style: none; padding: 0; margin: 18px 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
.honest li { padding: 16px 0 16px 44px; border-bottom: 1px dotted rgba(255, 255, 255, .16); position: relative; font-size: 17px; }
.honest li::before { content: '✕'; position: absolute; left: 0; top: 14px; width: 28px; height: 28px; border-radius: 4px; display: grid; place-items: center;
  font: 800 17px/1 var(--font-display); color: var(--before); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); }

.faq { padding-top: 64px; padding-bottom: 72px; max-width: 860px; }
.faq h2 { margin-bottom: 14px; }
details { border-bottom: 1px solid var(--rule); }
summary { cursor: pointer; list-style: none; padding: 16px 40px 16px 0; font: 800 22px/1.15 var(--font-display); text-transform: uppercase;
  letter-spacing: .01em; position: relative; transition: color .14s var(--ease); min-height: 44px; }
summary::-webkit-details-marker { display: none; }
summary::after { content: '↓'; position: absolute; right: 6px; top: 16px; transition: transform .2s var(--ease); }
details[open] summary::after { transform: rotate(180deg); }
summary:hover { color: var(--sign); }
details p { margin: 0 0 18px; max-width: 65ch; }

@media (max-width: 960px) {
  .hero { grid-template-columns: 1fr; grid-template-areas: "h" "plain" "booth" "copy"; row-gap: 20px; padding-top: 40px; }
  .receipts .grid { grid-template-columns: 1fr 1fr; }
  .receipt:nth-child(3) { border-left: 0; padding-left: 0; }
  .receipt:nth-child(n+3) { border-top: 2px dashed var(--rule); }
  .live-head { grid-template-columns: 1fr; gap: 10px; }
  .live :deep(.large .heads) { grid-template-columns: repeat(10, minmax(0, 1fr)); }
  .r5 { grid-row: auto; grid-column: span 2; }
}
@media (max-width: 560px) {
  .wide { padding-left: 16px; padding-right: 16px; } /* sides only: the sections keep their own top padding */
  .plain { font-size: 20px; }
  .sub { font-size: 17px; }
  .big { font-size: 19px; padding: 0 20px; }
  .num { font-size: 40px; }
  .unit { font-size: 18px; }
  .receipt { padding: 20px 12px 18px; }
  .tx { grid-template-columns: 1fr; padding: 18px; }
  .mid .display { transform: rotate(90deg); font-size: 34px; }
  .rules { grid-template-columns: 1fr; }
  .r5, .retry { grid-column: auto; }
  .honest ul { grid-template-columns: 1fr; }
  summary { font-size: 19px; }
}
</style>
