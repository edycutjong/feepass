<script setup lang="ts">
// Front-page replay of one sponsored send: lane 14 blinks amber while the wallet signs, turns green when the network takes the
// transaction, and the ticket feeds out of the slot. Every figure is imported from evidence/tx-shape.json (measured from the
// compiled covenant). The ticket says SAMPLE: the live lane board further down is the real mainnet state.
import { ref } from 'vue';
import { measured } from '../core/evidence';

defineProps<{ fee: string }>();
const std = measured.send;
const LANES = [11, 12, 13, 14, 15, 16, 17];
const CHOSEN = 14;
const run = ref(0);
</script>

<template>
  <figure class="booth" :key="run" aria-label="A sample send, replayed: lane 14 turns green and prints a ticket" data-testid="sample-booth">
    <div class="plate">
      <div class="heads">
        <div v-for="n in LANES" :key="n" class="head" :class="{ chosen: n === CHOSEN }">
          <span class="lamp" aria-hidden="true">↓</span>
          <span class="num">{{ n }}</span>
        </div>
      </div>
      <p class="cap"><strong>SAMPLE SEND</strong> · lane picked at random</p>
    </div>
    <div class="slot" aria-hidden="true"><span></span></div>
    <div class="feed">
      <article class="ticket" data-testid="sample-ticket">
        <header class="thead">
          <span class="display lane">Lane {{ CHOSEN }}</span>
          <span class="tag data">SAMPLE</span>
        </header>
        <p class="paid display">✓ Paid</p>
        <dl>
          <div><dt>Fee you paid</dt><dd><span data-testid="sample-fee">{{ fee }} PUSD</span><small>to the pool</small></dd></div>
          <div><dt>Miner fee</dt><dd><span data-testid="sample-miner">{{ std.minerFeeSats }} sats</span><small>paid by the lane</small></dd></div>
          <div class="spend"><dt>Spendable BCH</dt><dd>not used<small>a real ticket reads it from the chain</small></dd></div>
          <div><dt>Size</dt><dd data-testid="sample-size">{{ std.signedSizeBytes }} bytes</dd></div>
        </dl>
        <p class="foot">Figures computed offline from the compiled covenant. Not a mainnet send.</p>
      </article>
    </div>
    <figcaption><button type="button" class="linkbtn replay" data-testid="replay" @click="run++">↻ Replay the send</button></figcaption>
  </figure>
</template>

<style scoped>
.booth { margin: 0; display: grid; justify-items: center; }
.plate { width: 100%; background: var(--sign); color: var(--sign-ink); border-radius: 12px; padding: 22px 22px 12px;
  box-shadow: inset 0 0 0 3px var(--sign), inset 0 0 0 5px rgba(255, 255, 255, .92), 0 14px 30px rgba(17, 20, 24, .16); position: relative; z-index: 2; }
.heads { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; }
.head { display: grid; justify-items: center; gap: 4px; }
.lamp { width: 100%; max-width: 76px; aspect-ratio: 1; border-radius: 7px; background: var(--housing); color: var(--sign-ink);
  display: grid; place-items: center; font: 800 40px/1 var(--font-display); }
.num { font: 800 18px/1 var(--font-display); }
.chosen .lamp { background: var(--after); color: var(--sign-ink); animation: lane 2.1s steps(1, end) .5s both; }
.cap { margin: 12px 2px 0; font: 400 14px/1.2 var(--font-body); letter-spacing: .03em; text-align: center; }
.cap strong { font: 800 15px/1 var(--font-display); letter-spacing: .08em; }
/* lamp: amber blink while the wallet signs, then green when the network accepts (the hold at 99% keeps the last amber) */
@keyframes lane {
  0% { background: var(--housing); color: var(--sign-ink); }
  10% { background: var(--housing); color: var(--caution); }
  25% { background: var(--housing); color: var(--housing); }
  40% { background: var(--housing); color: var(--caution); }
  55% { background: var(--housing); color: var(--housing); }
  70% { background: var(--housing); color: var(--caution); }
  85% { background: var(--housing); color: var(--housing); }
  95% { background: var(--housing); color: var(--caution); }
  100% { background: var(--after); color: var(--sign-ink); }
}
.slot { width: 78%; height: 16px; margin-top: -2px; background: var(--housing); border-radius: 0 0 8px 8px; display: grid; place-items: center;
  position: relative; z-index: 2; }
.slot span { width: 86%; height: 3px; border-radius: 2px; background: #000; box-shadow: 0 1px 0 rgba(255, 255, 255, .12); }
.feed { width: 66%; overflow: hidden; margin-top: -6px; padding: 0 14px 22px; position: relative; z-index: 1; }
.ticket { position: relative; background: var(--paper); color: var(--ink); font-family: var(--font-data); padding: 22px 22px 14px;
  filter: drop-shadow(0 8px 12px rgba(17, 20, 24, .14)); animation: feed 1.25s cubic-bezier(.3, .1, .3, 1) 2.7s both; }
/* torn bottom edge */
.ticket::after { content: ''; position: absolute; left: 0; right: 0; bottom: -9px; height: 9px;
  background: linear-gradient(135deg, var(--paper) 50%, transparent 50%) 0 0 / 14px 9px repeat-x,
              linear-gradient(225deg, var(--paper) 50%, transparent 50%) 0 0 / 14px 9px repeat-x; }
@keyframes feed { from { transform: translateY(-104%); } to { transform: none; } }
.thead { display: flex; justify-content: space-between; align-items: center; gap: 10px; border-bottom: 2px dashed var(--rule); padding-bottom: 8px; }
.lane { font-size: 46px; }
.tag { font-size: 16px; font-weight: 600; letter-spacing: .12em; border: 2px solid var(--ink); border-radius: 5px; padding: 5px 9px; }
.paid { color: var(--after); font-size: 54px; margin: 10px 0 6px; transform-origin: left center; animation: stamp .4s var(--ease) 3.95s both; }
@keyframes stamp { from { transform: scale(1.5); opacity: 0; } to { transform: none; opacity: 1; } }
dl { margin: 0; display: grid; gap: 0; font-size: 15px; }
dl div { display: grid; grid-template-columns: 8.4em 1fr; gap: 8px; padding: 7px 0; border-bottom: 1px dotted var(--rule); }
dt { color: var(--muted); }
dd { margin: 0; font-size: 17px; font-weight: 600; }
dd small { display: block; font: 400 13px/1.35 var(--font-body); color: var(--muted); }
.foot { margin: 12px 0 0; font: 600 13px/1.4 var(--font-body); color: var(--muted); }
.replay { font-size: 15px; display: inline-flex; align-items: center; }
.replay:hover { color: var(--sign); }
@media (max-width: 560px) {
  .plate { padding: 12px 10px 8px; }
  .heads { gap: 6px; }
  .lamp { font-size: 22px; border-radius: 4px; }
  .num { font-size: 12px; }
  .feed { width: 92%; padding: 0 8px 20px; }
  .slot { width: 96%; }
  .lane { font-size: 30px; }
  .paid { font-size: 36px; }
  dl div { grid-template-columns: 7.4em 1fr; }
  .tag { font-size: 13px; padding: 4px 7px; }
  .spend small { display: none; } /* keep the mobile ticket short; who-pays lines stay */
  .cap { font-size: 12px; }
}
</style>
