<script setup lang="ts">
// FeePass: connect a WizardConnect wallet (mainnet enforced by the app), see PUSD and spendable BCH, send PUSD with the
// network fee paid by a covenant lane, get the ticket. /pool shows the pool read-only.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { WizardConnectQRDialog } from '@paytaca/wizardconnect-vue';
import { config } from '../core/config';
import { formatUnits } from '../core/amounts';
import { STARTER_DEFAULTS } from '../core/starter';
import { useFeePass } from './useFeePass';
import AppHeader from './AppHeader.vue';
import LaneBoard from './LaneBoard.vue';
import SendForm from './SendForm.vue';
import TicketCard from './TicketCard.vue';
import StateNotice from './StateNotice.vue';
import PoolPage from './PoolPage.vue';

const fp = useFeePass();
const { wc } = fp;
const isPool = typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/pool';
const showQr = ref(false);
const fee = formatUnits(config.params.feeTokens, config.decimals);
const starterAmount = formatUnits(STARTER_DEFAULTS.claimUnits, config.decimals);
const starterCap = STARTER_DEFAULTS.dailyCap;
/** What to do next for each faucet refusal: a limit is never a dead end. */
function starterHelp(code: string): string {
  switch (code) {
    case 'ALREADY_CLAIMED': return 'If your wallet shows no PUSD, press Rescan: the coin may still be unconfirmed.';
    case 'DAILY_CAP': return 'The day resets at 00:00 UTC. You can also send PUSD to your wallet yourself.';
    case 'IP_LIMIT': return 'Try again in an hour, or use PUSD you already hold.';
    case 'FAUCET_EMPTY': case 'FAUCET_NO_BCH': return 'The faucet is out for now. Use PUSD you already hold, or ask the team in the BLAZE Telegram (t.me/bchblaze).';
    default: return 'Try again in a minute.';
  }
}
const busy = computed(() => fp.resuming.value || !['idle', 'done'].includes(fp.phase.value));
const chosenNumber = computed(() => fp.board.value?.lanes.find((l) => l.outpoint === fp.activeLane.value)?.number ?? null);

function connect() {
  if (wc.connect()) showQr.value = true;
}
const stopQr = computed(() => fp.connected.value);

function onSend(recipient: string, amount: bigint) {
  void fp.send(recipient, amount);
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void fp.refreshChain();
  void fp.refreshBoard();
  void fp.resumePending();
  timer = setInterval(() => { if (!busy.value) void fp.refreshBoard(); }, 20_000);
});
onBeforeUnmount(() => clearInterval(timer));
const bch = (s: bigint | null) => (s === null ? 'unknown' : (Number(s) / 1e8).toFixed(8));
</script>

<template>
  <AppHeader :height="fp.height.value" :chain-error="fp.chainError.value" :connected="fp.connected.value"
    :wallet-name="wc.walletName.value" :repo-url="config.repoUrl" :payout="config.payoutAddress" @connect="connect" @disconnect="wc.disconnect()" />

  <PoolPage v-if="isPool" :cfg="config" :board="fp.board.value" :error="fp.boardError.value"
    :contract-address="fp.pool.address" :token-address="fp.pool.tokenAddress" />

  <main v-else class="wrap">
    <section class="hero" v-if="!fp.connected.value && !fp.sentTxid.value">
      <h1 class="display">Send dollars. No spendable BCH needed.</h1>
      <p class="lede">Pay the Bitcoin Cash network fee in PUSD. A covenant pays the fee; you pay {{ fee }} PUSD in the same transaction.</p>
      <button type="button" class="btn big" @click="connect">Connect wallet</button>
      <p class="muted small">WizardConnect wallet · mainnet</p>
    </section>

    <LaneBoard :board="fp.board.value" :error="fp.boardError.value" :active="fp.activeLane.value" :chosen="fp.chosenLane.value" :slots="config.lanes" />

    <StateNotice v-if="fp.notice.value" :notice="fp.notice.value" :can-resend="!!fp.pending.value" :busy="fp.resending.value"
      @resend="fp.resendPending()" @start-over="fp.startOver()" @dismiss="fp.notice.value = null" />

    <template v-if="fp.sentTxid.value">
      <TicketCard v-if="fp.ticket.value" :ticket="fp.ticket.value" :lane="fp.ticketLane.value" :explorer-tx="config.explorerTx" :fee="fee" :at="fp.ticketAt.value" />
      <section v-else class="panel" data-testid="sent-fallback">
        <h2>Sent</h2>
        <p>The network accepted the transaction. <a :href="config.explorerTx + fp.sentTxid.value" target="_blank" rel="noopener">View it on the explorer ↗</a></p>
        <p class="data muted">{{ fp.sentTxid.value }}</p>
      </section>
      <p class="again"><button type="button" class="btn ghost" @click="fp.startOver()">Send again</button></p>
    </template>

    <template v-else-if="fp.connected.value">
      <section class="panel balances" aria-label="Your balances">
        <div class="bal"><span class="lbl">PUSD</span>
          <span class="big data" data-testid="pusd">{{ fp.wallet.value ? formatUnits(fp.wallet.value.pusdUnits) : '…' }}</span></div>
        <div class="bal"><span class="lbl">Spendable BCH</span>
          <span class="data" data-testid="spendable">{{ fp.wallet.value ? bch(fp.wallet.value.spendableBchSats) : '…' }}</span></div>
        <p v-if="fp.wallet.value && fp.wallet.value.failedLookups" class="muted small">
          {{ fp.wallet.value.failedLookups }} of {{ fp.wallet.value.lookups }} address lookups failed; spendable BCH is unknown until a rescan succeeds.</p>
        <p v-if="fp.wallet.value && fp.wallet.value.coins.length === 0 && !fp.wallet.value.failedLookups" class="nopusd">
          ✕ No PUSD found on mainnet in the addresses this wallet shared. <span class="muted">Is your wallet set to mainnet?</span></p>
        <div v-if="fp.wallet.value && fp.wallet.value.coins.length === 0 && !fp.wallet.value.failedLookups" class="starter" data-testid="starter">
          <template v-if="fp.starter.value.txid">
            <p class="small" data-testid="starter-sent">Starter claim sent: <a :href="config.explorerTx + fp.starter.value.txid" target="_blank" rel="noopener" class="data">{{ fp.starter.value.txid.slice(0, 10) }}…</a>.
              {{ fp.starter.value.state === 'waiting' ? 'Waiting for the coin to show up…' : 'If your balance still shows no PUSD, press Rescan in a few seconds.' }}</p>
          </template>
          <template v-else>
            <p class="small">New to PUSD? Take <strong>{{ starterAmount }} PUSD</strong> from the FeePass faucet, once per address, to try one send. It is a small shared budget:
              {{ starterCap }} claims per UTC day, so it can run out.</p>
            <button type="button" class="btn" data-testid="starter-claim" :disabled="fp.starter.value.state === 'claiming'"
              @click="fp.claimStarterPusd()">{{ fp.starter.value.state === 'claiming' ? 'Asking the faucet…' : `Get ${starterAmount} starter PUSD` }}</button>
            <p v-if="fp.starter.value.state === 'error'" class="small starter-err" role="alert" :data-code="fp.starter.value.code">✕ {{ fp.starter.value.message }}
              <span class="muted">{{ starterHelp(fp.starter.value.code) }}</span></p>
          </template>
        </div>
        <button type="button" class="linkbtn" :disabled="fp.scanning.value" @click="fp.scan()">{{ fp.scanning.value ? 'Reading mainnet…' : 'Rescan' }}</button>
      </section>

      <section v-if="busy" class="panel progress" aria-live="polite">
        <template v-if="fp.phase.value === 'signing'">
          <p class="display step">Lane {{ chosenNumber }} · approve in your wallet</p>
          <p v-if="fp.signingSend.value" class="muted">This transaction has 3 outputs (a wallet that itemizes them will show): {{ formatUnits(fp.signingSend.value.outputs.changeUnits) }} PUSD back to you,
            {{ formatUnits(fp.signingSend.value.outputs.laneUnits) }} PUSD to the pool (the lane's own PUSD plus your {{ fee }} fee), and your send. Network fee
            {{ fp.signingSend.value.minerFeeSats }} sats, paid by the lane.</p>
          <p v-if="fp.signatures.value > 1" class="muted">{{ fp.retryReason.value === 'lane-conflict' ? 'The previous lane was taken by another send' : 'The previous lane could not be used' }}; this is signature {{ fp.signatures.value }}, same coin.</p>
        </template>
        <p v-else-if="fp.phase.value === 'starting'" class="display step">Reading the pool…</p>
        <p v-else-if="fp.phase.value === 'broadcasting'" class="display step">Broadcasting…</p>
        <p v-else-if="fp.phase.value === 'waiting-lane'" class="display step">Lane still propagating · {{ fp.waitSeconds.value }} s</p>
        <p v-else-if="fp.phase.value === 'retrying'" class="display step">Lane busy · picking another</p>
      </section>

      <SendForm v-if="fp.wallet.value && fp.wallet.value.coins.length && !fp.pending.value" :cfg="config" :wallet="fp.wallet.value"
        :board="fp.board.value" :pool="fp.pool" :max-units="fp.maxUnits.value" :busy="busy" @send="onSend" />
    </template>

    <section class="how" v-if="!fp.connected.value && !fp.sentTxid.value">
      <h2 class="display">How it works</h2>
      <ol>
        <li>Connect a WizardConnect wallet that holds PUSD. It needs no spendable BCH.</li>
        <li>FeePass builds one fixed transaction: your PUSD coin plus one pool lane. Your wallet signs only its own input.</li>
        <li>The lane pays the miner fee; the covenant makes the transaction return exactly {{ fee }} PUSD to the pool.</li>
      </ol>
      <p><a href="/pool">Pool page</a> · <a :href="config.repoUrl + '/blob/main/contracts/FeePassPool.cash'" target="_blank" rel="noopener">Contract source</a></p>
    </section>
  </main>

  <WizardConnectQRDialog v-if="wc.uri.value && wc.qrUri.value" :show="showQr && !stopQr" :on-close="() => (showQr = false)"
    :uri="wc.uri.value" :qr-uri="wc.qrUri.value" title="Connect a BCH wallet" subtitle="Scan with a WizardConnect wallet"
    :theme="{ headerBackground: '#1F4F9A', titleColor: '#FFFFFF', subtitleColor: '#FFFFFF', dialogBackground: '#FBFBF7', qrForeground: '#16202B', qrBackground: '#FFFFFF' }" />
</template>

<style scoped>
.hero { padding: 40px 0 22px; }
.hero h1 { font-size: 56px; max-width: 13ch; }
.lede { font-size: 20px; max-width: 34em; margin: 14px 0 20px; }
.big { min-height: 56px; font-size: 22px; padding: 0 28px; }
.small { font-size: 15px; }
.balances { display: grid; gap: 6px; }
.bal { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.lbl { font-weight: 600; }
.bal .big { font-size: 36px; }
.nopusd { margin: 8px 0 0; }
.progress .step { font-size: 26px; margin: 0 0 8px; }
.again { text-align: center; margin: 22px 0 40px; }
.how { margin: 30px 0 50px; }
.how h2 { font-size: 32px; }
.how ol { padding-left: 22px; }
@media (max-width: 480px) { .hero h1 { font-size: 40px; } .bal .big { font-size: 30px; } }
.starter { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--rule); display: grid; gap: 8px; justify-items: start; }
.starter-err { color: var(--ink); margin: 0; }
</style>
