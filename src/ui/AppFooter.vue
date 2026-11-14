<script setup lang="ts">
defineProps<{ repoUrl: string }>();
</script>

<template>
  <footer class="ftr">
    <div class="inner">
      <a class="brand display" href="/">FeePass</a>
      <nav class="links" aria-label="Footer">
        <a href="/deck/">Pitch deck</a>
        <a :href="repoUrl" target="_blank" rel="noopener">Source</a>
        <a :href="repoUrl + '/blob/main/contracts/FeePassPool.cash'" target="_blank" rel="noopener">Covenant</a>
        <a href="/pool">Pool</a>
        <a href="/gate.html">Wallet gate</a>
      </nav>
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
.note { grid-column: 1 / -1; margin: 6px 0 0; font-size: 14px; color: #B7CBEC; }
@media (max-width: 560px) { .inner { grid-template-columns: 1fr; padding: 24px 16px; } .links { justify-content: flex-start; } }
</style>
