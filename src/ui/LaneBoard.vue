<script setup lang="ts">
// The signature element: one signal head per pool lane, read live from Fulcrum. ↓ white = open, amber = busy, ✕ red = closed.
// The chosen lane blinks amber while the wallet signs and turns green when the network accepts the send.
import { computed } from 'vue';
import type { Board } from '../core/lanes';

const props = defineProps<{ board: Board | null; error: string; active: string | null; chosen: string | null; slots: number; large?: boolean }>();

const heads = computed(() => {
  const lanes = props.board?.lanes ?? [];
  // Pool not funded yet (or still loading): N unlit heads, so the gantry reads as a gantry and nothing claims a lane exists.
  if (lanes.length === 0) return Array.from({ length: props.slots }, (_, k) => ({ key: `dark-${k}`, number: k + 1, state: 'dark', glyph: '', label: `Lane ${k + 1} not funded` }));
  return lanes.map((l) => {
    const state = l.outpoint === props.chosen ? 'paid' : l.outpoint === props.active ? 'busy' : l.state;
    const glyph = state === 'closed' ? '✕' : '↓';
    const word = state === 'paid' ? 'paid' : state;
    return { key: l.outpoint, number: l.number, state, glyph, label: `Lane ${l.number} ${word}` };
  });
});
</script>

<template>
  <section class="gantry" :class="{ large }" aria-label="Pool lanes">
    <div class="heads" role="list">
      <div v-for="h in heads" :key="h.key" class="head" :class="h.state" role="listitem" :aria-label="h.label" :title="h.label">
        <span class="lamp" aria-hidden="true">{{ h.glyph }}</span>
        <span class="num">{{ h.number }}</span>
      </div>
    </div>
    <p class="caption data">
      <template v-if="error">Lane board unavailable: {{ error }}</template>
      <template v-else-if="!board">Reading the pool…</template>
      <template v-else-if="board.lanes.length === 0">Pool not open yet: no funded lanes at the covenant address.</template>
      <template v-else>{{ board.open }} of {{ board.lanes.length }} lanes open<span v-if="board.lanes.length < slots"> · {{ slots }} planned</span></template>
    </p>
  </section>
</template>

<style scoped>
.gantry { background: var(--sign); color: var(--sign-ink); border-radius: 8px; padding: 14px 14px 8px; box-shadow: inset 0 0 0 2px var(--sign), inset 0 0 0 4px rgba(255,255,255,.9); }
.heads { display: grid; grid-template-columns: repeat(auto-fill, minmax(28px, 1fr)); gap: 6px; min-height: 52px; }
.large .heads { grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 10px; }
.head { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.lamp { width: 100%; aspect-ratio: 1; max-width: 40px; border-radius: 4px; background: var(--housing); display: grid; place-items: center;
  font: 800 18px/1 var(--font-display); color: var(--sign-ink); transition: background-color .3s var(--ease), color .3s var(--ease); }
.large .lamp { max-width: 56px; font-size: 26px; }
.num { font: 800 12px/1 var(--font-display); opacity: .9; }
.closed .lamp { color: var(--before); }
.busy .lamp { color: var(--caution); animation: blink 0.9s steps(2, jump-none) infinite; }
.dark .lamp { background: #1b2027; }
.dark .num { color: var(--sign-dim); opacity: 1; } /* 4.8:1 on sign blue; a faded white failed contrast */
.paid .lamp { background: var(--after); color: var(--sign-ink); }
.caption { margin: 8px 2px 2px; font-size: 13px; opacity: .92; }
@keyframes blink { 50% { color: var(--housing); } }
@media (max-width: 480px) { .heads { grid-template-columns: repeat(10, 1fr); } }
</style>
