<script setup lang="ts">
defineProps<{ height: number | null; chainError: string; connected: boolean; walletName: string | null; repoUrl: string; payout: string }>();
defineEmits<{ connect: []; disconnect: [] }>();
import { ref } from 'vue';
// BCH BLAZE 2026 eligibility banner (top of the home page): the Widget Factory presentation, the repo, and the CashTokens
// address for EMBER2026 Community Choice votes.
const SLIDES_URL = 'https://docs.google.com/presentation/d/1cqIM2GuEVrLRrAz3gNQu9_Uvzr4C1IgKN67-z_rSNao/edit?usp=sharing';
const copied = ref(false);
async function copyAddr(addr: string) {
  try { await navigator.clipboard.writeText(addr); copied.value = true; setTimeout(() => (copied.value = false), 1600); } catch { /* clipboard blocked: the address stays selectable */ }
}
</script>

<template>
  <aside class="blaze" aria-label="BCH BLAZE 2026 project links" data-testid="blaze-banner">
    <div class="wrap blz">
      <span class="tag">BCH BLAZE 2026 · new project, built during the hackathon</span>
      <a :href="SLIDES_URL" target="_blank" rel="noopener" data-testid="blaze-slides">Presentation (Widget Factory) ↗</a>
      <a :href="repoUrl" target="_blank" rel="noopener" data-testid="blaze-repo">GitHub ↗</a>
      <span class="vote">EMBER2026 votes: <span class="data addr" data-testid="blaze-ember">{{ payout }}</span>
        <button type="button" class="cp" @click="copyAddr(payout)" :aria-label="copied ? 'Address copied' : 'Copy the EMBER2026 address'">{{ copied ? 'Copied' : 'Copy' }}</button></span>
    </div>
  </aside>
  <header class="hdr">
    <div class="wrap bar">
      <a class="brand display" href="/" aria-label="FeePass home"><img src="/icon.svg" alt="" width="38" height="38" class="mark">FeePass</a>
      <span class="net data" :class="{ off: !!chainError }" data-testid="mainnet-status" :title="chainError || undefined">
        <template v-if="height">MAINNET · {{ height.toLocaleString('en-US') }}</template>
        <template v-else-if="chainError">MAINNET · OFFLINE</template>
        <template v-else>MAINNET</template>
      </span>
      <button v-if="!connected" type="button" class="btn connect" data-testid="connect" @click="$emit('connect')">Connect wallet</button>
      <button v-else type="button" class="btn connect on" :title="'Disconnect ' + (walletName ?? 'wallet')" @click="$emit('disconnect')">
        {{ walletName ?? 'Wallet' }} ✓
      </button>
    </div>
    <nav class="wrap links" aria-label="Project links">
      <a href="/deck/">Pitch deck</a>
      <a :href="repoUrl" target="_blank" rel="noopener">Repo</a>
      <a href="/pool">Pool</a>
    </nav>
  </header>
</template>

<style scoped>
.blaze { background: var(--housing); color: #E8ECEF; font-size: 14px; }
.blaze .wrap { max-width: 1140px; padding: 0 24px; margin: 0 auto; }
.blz { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 18px; min-height: 40px; padding: 4px 0; }
.blaze .tag { font: 600 12px/1.3 var(--font-data); letter-spacing: .06em; text-transform: uppercase; color: var(--caution); }
.blaze a { color: #FFFFFF; min-height: 36px; display: inline-flex; align-items: center; text-underline-offset: 3px; }
.blaze a:hover { text-decoration-thickness: 2px; opacity: .85; }
.blaze .vote { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.blaze .addr { font-size: 13px; overflow-wrap: anywhere; user-select: all; }
.blaze .cp { font: 600 12px/1 var(--font-body); color: var(--housing); background: #E8ECEF; border: 0; border-radius: 4px; padding: 6px 9px; min-height: 28px; cursor: pointer;
  transition: opacity .14s var(--ease), transform .14s var(--ease); }
.blaze .cp:hover { opacity: .85; } .blaze .cp:active { transform: translateY(1px); }
.blaze :focus-visible { outline-color: #FFFFFF; }
@media (max-width: 560px) { .blaze .wrap { padding: 0 16px; } }
.hdr { background: var(--sign); color: var(--sign-ink); box-shadow: inset 0 0 0 3px var(--sign), inset 0 0 0 5px rgba(255,255,255,.9); padding: 10px 0 8px; }
.hdr .wrap { max-width: 1140px; padding: 0 24px; }
.bar { display: flex; align-items: center; gap: 14px; min-height: 56px; }
.brand { color: var(--sign-ink); text-decoration: none; font-size: 32px; letter-spacing: .03em; min-height: 44px; display: inline-flex; align-items: center; transition: letter-spacing .14s var(--ease), opacity .14s var(--ease); }
.brand:hover { letter-spacing: .06em; opacity: .85; }
.mark { width: 38px; height: 38px; margin-right: 10px; border-radius: 7px; }
.net { margin-left: auto; font-size: 13px; letter-spacing: .06em; opacity: .92; white-space: nowrap; }
.net.off { color: var(--caution); }
.connect { background: var(--sign-ink); color: var(--sign); border-color: var(--sign-ink); box-shadow: 0 2px 0 var(--housing); }
.connect.on { background: transparent; color: var(--sign-ink); }
.links { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; font-size: 15px; padding-bottom: 4px; }
.links a { color: var(--sign-ink); min-height: 44px; display: inline-flex; align-items: center; }
.links a:hover { text-decoration-thickness: 2px; opacity: .85; }
.connect { white-space: nowrap; }
@media (max-width: 560px) { .hdr .wrap { padding: 0 16px; } }
@media (max-width: 480px) { .connect { font-size: 15px; padding: 0 12px; } .brand { font-size: 26px; } .mark { width: 32px; height: 32px; } .net { display: none; } .connect { margin-left: auto; } }
</style>
