<script setup lang="ts">
// One named notice per failure state (ui.md "States"): ink on paper, a red ✕ and the reason. No separate error red.
import type { Notice } from './useFeePass';
defineProps<{ notice: Notice; canResend: boolean; busy?: boolean }>();
defineEmits<{ resend: []; startOver: []; dismiss: [] }>();
const titles: Record<string, string> = {
  NO_COIN: 'No coin fits this send', EARLIER_SEND_LANDED: 'Your earlier send landed', RELAY_TIMEOUT: 'Wallet did not answer', SEND_IN_PROGRESS: 'Send in progress', BAD_RECIPIENT: 'Check the address', DISCARDED: 'Old pending send discarded', POOL_EMPTY: 'No open lane', POOL_BUSY: 'Pool busy', WALLET_REJECTED: 'Not signed',
  NONCONFORMANT_SIGHASH: "This wallet's signature can't be used", WALLET_CHANGED_TX: 'The wallet changed the transaction',
  COIN_CHANGED: 'Your coin changed', BROADCAST_UNKNOWN: 'Broadcast status unknown', PENDING: 'Send in progress',
  SCAN: 'Could not read your wallet', CHAIN: 'Something went wrong',
};
</script>

<template>
  <div class="notice" role="alert" :data-code="notice.code">
    <p class="t"><span class="x" aria-hidden="true">✕</span> {{ titles[notice.code] ?? notice.code }}</p>
    <p class="m">{{ notice.message }}</p>
    <div class="row">
      <button v-if="canResend" type="button" class="btn small" :disabled="busy" @click="$emit('resend')">{{ busy ? 'Re-sending…' : 'Re-send the same transaction' }}</button>
      <button v-if="canResend" type="button" class="btn ghost small" :disabled="busy" @click="$emit('startOver')">Start over with this coin</button>
      <button v-if="!canResend" type="button" class="btn ghost small" @click="$emit('dismiss')">OK</button>
    </div>
  </div>
</template>

<style scoped>
.notice { background: var(--paper); border: 1px solid var(--rule); border-left: 4px solid var(--before); border-radius: 6px; padding: 14px 16px; margin: 16px 0; }
.t { font: 800 20px/1.1 var(--font-display); text-transform: uppercase; margin: 0 0 6px; }
.x { color: var(--before); }
.m { margin: 0 0 10px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
</style>
