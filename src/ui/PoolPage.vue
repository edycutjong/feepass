<script setup lang="ts">
// S5 /pool: read-only. Every lane's outpoint and value from Fulcrum, the PUSD the pool has earned, the covenant address and
// the contract source, so a judge can verify the pool without trusting the UI.
import { computed } from 'vue';
import { formatUnits, shortHex } from '../core/amounts';
import type { AppConfig } from '../core/config';
import type { Board } from '../core/lanes';
import { LANE_SEED_UNITS } from '../core/params';
import LaneBoard from './LaneBoard.vue';

const props = defineProps<{ cfg: AppConfig; board: Board | null; error: string; contractAddress: string; tokenAddress: string }>();
const earned = computed(() => (props.board ? props.board.poolUnits - BigInt(props.board.lanes.length) * LANE_SEED_UNITS : 0n));
const lastTxs = computed(() => [...new Set((props.board?.lanes ?? []).map((l) => l.utxo.txid))].slice(0, 10));
</script>

<template>
  <main class="wrap">
    <h1 class="display h">The pool</h1>
    <p class="muted">A CashScript covenant holding BCH in lanes ({{ board?.lanes.length ?? 0 }} funded, {{ cfg.lanes }} planned). Each sponsored send takes one lane, pays the miner fee
      from it (at most {{ cfg.params.maxSubsidy }} sats per transaction) and must return exactly {{ formatUnits(cfg.params.feeTokens) }} PUSD to it.</p>
    <LaneBoard :board="board" :error="error" :active="null" :chosen="null" :slots="cfg.lanes" large />
    <div class="panel">
      <h2>Totals</h2>
      <dl class="kv">
        <div><dt>Lanes open</dt><dd class="data">{{ board ? `${board.open} / ${board.lanes.length}` : '—' }}</dd></div>
        <div><dt>BCH in lanes</dt><dd class="data">{{ board ? (Number(board.poolSats) / 1e8).toFixed(8) : '—' }}</dd></div>
        <div><dt>PUSD fees earned</dt><dd class="data">{{ board ? formatUnits(earned) : '—' }} PUSD <small class="muted">(estimate: PUSD in the lanes shown minus the {{ formatUnits(LANE_SEED_UNITS) }} seed each lane starts with)</small></dd></div>
        <div v-if="board && board.otherCoins"><dt>Other coins</dt><dd>+{{ board.otherCoins }} other coins at the pool address</dd></div>
      </dl>
    </div>
    <div class="panel" v-if="board && board.lanes.length">
      <h2>Lanes</h2>
      <table class="data">
        <thead><tr><th>Lane</th><th>Outpoint</th><th>sats</th><th>PUSD</th><th>State</th></tr></thead>
        <tbody>
          <tr v-for="l in board.lanes" :key="l.outpoint">
            <td>{{ l.number }}</td>
            <td><a :href="cfg.explorerTx + l.utxo.txid" target="_blank" rel="noopener">{{ shortHex(l.utxo.txid) }}:{{ l.utxo.vout }}</a></td>
            <td>{{ l.valueSats }}</td><td>{{ formatUnits(l.pusdUnits) }}</td><td>{{ l.state }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small">Transaction that created each lane's current coin (a send or the split):
        <template v-for="(t, i) in lastTxs" :key="t"><a :href="cfg.explorerTx + t" target="_blank" rel="noopener" class="data">{{ shortHex(t, 4, 4) }}</a><span v-if="i < lastTxs.length - 1"> · </span></template>
      </p>
    </div>
    <div class="panel">
      <h2>Contract</h2>
      <dl class="kv">
        <div><dt>Covenant (token address)</dt><dd class="data">{{ tokenAddress }}</dd></div>
        <div><dt>Covenant (P2SH32)</dt><dd class="data">{{ contractAddress }}</dd></div>
        <div><dt>Source</dt><dd><a :href="cfg.repoUrl + '/blob/main/contracts/FeePassPool.cash'" target="_blank" rel="noopener">contracts/FeePassPool.cash</a></dd></div>
        <div><dt>Artifact sha256</dt><dd class="data">{{ cfg.artifactSha256 }}</dd></div>
        <div><dt>Rules</dt><dd>fee {{ formatUnits(cfg.params.feeTokens) }} PUSD · cap {{ cfg.params.maxSubsidy }} sats · top-up ≤ {{ cfg.params.maxTopUp }} sats</dd></div>
      </dl>
    </div>
  </main>
</template>

<style scoped>
.h { font-size: 48px; margin: 28px 0 8px; }
.kv { margin: 0; display: grid; gap: 8px; }
.kv div { display: grid; grid-template-columns: 12em 1fr; gap: 10px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--rule); }
.small { font-size: 14px; }
@media (max-width: 480px) { .kv div { grid-template-columns: 1fr; gap: 0; } .h { font-size: 40px; } }
</style>
