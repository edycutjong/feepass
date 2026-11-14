<script setup lang="ts">
// S4, the hero screen: the toll ticket. Every figure comes from the broadcast transaction (receipt.ts), none from the form.
import { formatUnits, shortAddress, shortHex } from '../core/amounts';
import type { Ticket } from '../core/receipt';

defineProps<{ ticket: Ticket; lane: number | null; explorerTx: string; fee: string; at: string }>();
const bch = (s: bigint | null) => (s === null ? 'unknown' : (Number(s) / 1e8).toFixed(8));
</script>

<template>
  <article class="ticket" aria-label="Toll ticket" data-testid="ticket">
    <header class="head">
      <span class="display lane">Lane {{ lane ?? '—' }}</span>
      <span class="data when">{{ at }}</span>
    </header>
    <p class="paid display">✓ Paid</p>
    <dl>
      <div><dt>Sent</dt><dd>{{ formatUnits(ticket.sentUnits) }} PUSD → {{ shortAddress(ticket.recipient) }}</dd></div>
      <div><dt>Fee you paid</dt><dd>{{ formatUnits(ticket.feeUnits) }} PUSD (to the pool)</dd></div>
      <div><dt>Pool subsidy</dt><dd>{{ ticket.poolSubsidySats }} sats<small> (miner fee {{ ticket.minerFeeSats }}<template v-if="ticket.topUpSats > 0n"> + top-up {{ ticket.topUpSats }}</template>)</small></dd></div>
      <div><dt>Spendable BCH</dt><dd>{{ bch(ticket.spendableBefore) }} → {{ bch(ticket.spendableAfter) }}</dd></div>
      <div><dt>Your coin sats</dt><dd>{{ ticket.coinSatsBefore }} → {{ ticket.coinSatsAfter }}</dd></div>
      <div><dt>Size</dt><dd>{{ ticket.sizeBytes }} bytes</dd></div>
      <div class="tx"><dt>txid</dt><dd>{{ shortHex(ticket.txid, 8, 8) }} <a :href="explorerTx + ticket.txid" target="_blank" rel="noopener">view on explorer ↗</a></dd></div>
    </dl>
  </article>
  <p v-if="ticket.headline" class="headline display" data-testid="headline">{{ ticket.headline }}</p>
  <p v-if="ticket.headline" class="inputs muted">Inputs: your PUSD coin · pool lane {{ lane ?? '' }}</p>
  <p v-if="ticket.balanceUnchanged" class="f4">Your BCH balance didn't change.</p>
</template>

<style scoped>
.ticket { position: relative; max-width: 420px; margin: 18px auto 0; background: var(--paper); color: var(--ink); font-family: var(--font-data);
  padding: 22px 22px 16px; border: 1px solid var(--rule); border-top: 0; box-shadow: 0 10px 24px rgba(17, 20, 24, .12);
  animation: print .6s var(--ease) both; }
.ticket::before { content: ''; position: absolute; left: -1px; right: -1px; top: -8px; height: 8px;
  background: radial-gradient(circle at 6px 0, transparent 5px, var(--paper) 5.5px) 0 0 / 12px 8px repeat-x; }
.head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px dashed var(--rule); padding-bottom: 8px; }
.lane { font-size: 32px; }
.when { font-size: 13px; color: var(--muted); }
.paid { color: var(--after); font-size: 30px; margin: 10px 0 6px; }
dl { margin: 0; display: grid; gap: 6px; font-size: 15px; }
dl div { display: grid; grid-template-columns: 9.5em 1fr; gap: 8px; border-bottom: 1px dotted var(--rule); padding-bottom: 5px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; font-size: 16px; }
small { color: var(--muted); font-size: 13px; }
.headline { text-align: center; font-size: 32px; margin: 22px 0 4px; }
.inputs, .f4 { text-align: center; margin: 2px 0; }
.f4 { font-weight: 600; }
@keyframes print { from { transform: translateY(-14px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (max-width: 480px) { dl div { grid-template-columns: 1fr; gap: 0; } .headline { font-size: 28px; } }
</style>
