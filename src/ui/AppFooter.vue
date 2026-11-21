<script setup lang="ts">
defineProps<{ repoUrl: string; payout: string }>();
const version = __APP_VERSION__;
</script>

<template>
  <footer class="ftr">
    <div class="inner">
      <a class="brand display" href="/">FeePass</a>
      <nav class="links" aria-label="Footer">
        <a href="/judge/">For judges</a>
        <a href="/deck/">Pitch deck</a>
        <a :href="repoUrl" target="_blank" rel="noopener">Source</a>
        <a :href="repoUrl + '/blob/main/contracts/FeePassPool.cash'" target="_blank" rel="noopener">Covenant</a>
        <a href="/pool">Pool</a>
        <a href="/gate.html">Wallet gate</a>
        <a class="rel" :href="repoUrl + '/releases/tag/' + version" target="_blank" rel="noopener" :aria-label="'Release ' + version">
          <img :src="'https://img.shields.io/github/v/release/edycutjong/feepass?sort=semver&style=flat&label=release&color=0AC18E'" alt="" width="104" height="20" loading="lazy">
          <span class="data">{{ version }}</span>
        </a>
      </nav>
      <p class="addr" title="CashTokens address for BCH BLAZE Community Choice: send EMBER2026 tokens here to vote"><span class="addr-l">Community Choice · send EMBER2026 votes to</span> <span class="data">{{ payout }}</span></p>
      <p class="note">Built for BCH BLAZE 2026 · MIT licence · Bitcoin Cash mainnet</p>
    </div>
  </footer>
</template>

<style scoped>
.ftr { background: var(--sign); color: var(--sign-ink); box-shadow: inset 0 0 0 3px var(--sign), inset 0 0 0 5px rgba(255, 255, 255, .9); }
.inner { max-width: 1140px; margin: 0 auto; padding: 30px 24px 26px; display: grid; grid-template-columns: auto 1fr; gap: 6px 32px; align-items: center; }
.brand { color: var(--sign-ink); text-decoration: none; font-size: 34px; letter-spacing: .03em; min-height: 44px; display: inline-flex; align-items: center;
  transition: letter-spacing .14s var(--ease), opacity .14s var(--ease); }
.brand:hover { letter-spacing: .06em; opacity: .85; }
.links { display: flex; flex-wrap: wrap; gap: 4px 22px; justify-content: flex-end; }
.links a { color: var(--sign-ink); font-size: 16px; min-height: 44px; display: inline-flex; align-items: center; text-underline-offset: 3px; }
.links a:hover { text-decoration-thickness: 2px; opacity: .85; }
.rel { gap: 8px; text-decoration: none; }
.rel img { display: block; height: 20px; width: auto; }
.rel .data { font-size: 14px; }
.addr { grid-column: 1 / -1; margin: 10px 0 0; overflow-wrap: anywhere; }
.addr-l { font: 600 14px/1.4 var(--font-body); color: #B7CBEC; margin-right: 6px; }
.addr .data { font-size: 14px; }
.note { grid-column: 1 / -1; margin: 6px 0 0; font-size: 14px; color: #B7CBEC; }
@media (max-width: 560px) { .inner { grid-template-columns: 1fr; padding: 24px 16px; } .links { justify-content: flex-start; } }
</style>
