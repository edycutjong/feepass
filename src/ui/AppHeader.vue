<script setup lang="ts">
defineProps<{ height: number | null; chainError: string; connected: boolean; walletName: string | null; repoUrl: string; payout: string }>();
defineEmits<{ connect: []; disconnect: [] }>();
</script>

<template>
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
