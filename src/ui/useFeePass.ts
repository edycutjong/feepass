// App state for the FeePass screens: WizardConnect session, wallet scan, live lane board, the send, the ticket, and the one
// pending-send record. All chain logic lives in src/core; this file only wires it to Vue refs.
import { computed, ref, shallowRef, watch } from 'vue';
import { useWizardConnect } from '@paytaca/wizardconnect-vue';
import { ElectrumNetworkProvider } from 'cashscript';
import { appPool, config } from '../core/config';
import { lockingBytecodeOf } from '../core/dust';
import { deriveAddresses } from '../core/hdAddresses';
import { buildBoard, type Board } from '../core/lanes';
import { computeTicket, type Ticket } from '../core/receipt';
import {
  checkPending, FlowError, PENDING_TTL_MS, proposedFromPending, rebroadcast, runSend,
  type FlowErrorCode, type FlowEvent, type PendingSend, type PendingStore,
} from '../core/sendFlow';
import type { SponsoredSend } from '../core/sponsoredSend';
import { candidateCoins, maxSendUnits, scanWallet, type WalletScan } from '../core/walletScan';
import type { WizardSignRequest } from '../core/wizard';

// Mainnet only: the provider is built with 'mainnet' and there is no network switch (architecture §9.2).
const provider = new ElectrumNetworkProvider('mainnet');
const pool = appPool(config, provider);
const poolLock = lockingBytecodeOf(pool.tokenAddress);
const SIGN_TIMEOUT_MS = 180_000;
const PENDING_KEY = 'feepass.pending.v1';

const localStore: PendingStore = {
  load() {
    try {
      const v = localStorage.getItem(PENDING_KEY);
      return v ? (JSON.parse(v) as PendingSend) : null;
    } catch {
      return null;
    }
  },
  save: (p) => localStorage.setItem(PENDING_KEY, JSON.stringify(p)),
  clear: () => localStorage.removeItem(PENDING_KEY),
};

export type Phase = 'idle' | 'signing' | 'broadcasting' | 'waiting-lane' | 'retrying' | 'done';
export interface Notice { code: FlowErrorCode | 'PENDING' | 'SCAN' | 'CHAIN'; message: string }

export function useFeePass() {
  const wc = useWizardConnect({ dappName: 'FeePass', persistSession: true });
  const connected = computed(() => wc.state.value === 'connected');

  const height = ref<number | null>(null);
  const chainError = ref('');
  const board = shallowRef<Board | null>(null);
  const boardError = ref('');
  const wallet = shallowRef<WalletScan | null>(null);
  const scanning = ref(false);

  const phase = ref<Phase>('idle');
  const activeLane = ref<string | null>(null);
  const chosenLane = ref<string | null>(null);
  const signingSend = shallowRef<SponsoredSend | null>(null);
  const waitSeconds = ref(0);
  const signatures = ref(0);
  const notice = shallowRef<Notice | null>(null);
  const ticket = shallowRef<Ticket | null>(null);
  const ticketLane = ref<number | null>(null);
  const pending = shallowRef<PendingSend | null>(null);

  async function refreshChain() {
    try {
      height.value = await provider.getBlockHeight();
      chainError.value = '';
    } catch (e) {
      chainError.value = (e as Error).message;
    }
  }

  async function refreshBoard() {
    try {
      const busy = new Set(activeLane.value ? [activeLane.value] : []);
      board.value = buildBoard(await provider.getUtxos(pool.tokenAddress), {
        categoryDisplay: config.categoryDisplay, laneLock: poolLock, params: config.params, n: config.lanes, busy,
      });
      boardError.value = '';
    } catch (e) {
      boardError.value = (e as Error).message;
    }
  }

  function addresses() {
    const m = wc.manager.value;
    return m ? deriveAddresses(m.getSessionPaths()) : [];
  }

  async function scan() {
    if (!wc.manager.value) return;
    scanning.value = true;
    try {
      wallet.value = await scanWallet(provider, addresses(), config.categoryDisplay);
    } catch (e) {
      notice.value = { code: 'SCAN', message: (e as Error).message };
    } finally {
      scanning.value = false;
    }
  }

  watch(connected, async (c) => {
    if (c) await scan();
    else wallet.value = null;
  }, { immediate: true });

  const maxUnits = computed(() => (wallet.value ? maxSendUnits(wallet.value.coins, config.params) : 0n));

  async function sign(req: WizardSignRequest): Promise<string> {
    const m = wc.manager.value;
    if (!m) throw new Error('wallet disconnected');
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer from the wallet within 3 minutes (relay timeout)')), SIGN_TIMEOUT_MS));
    const res = await Promise.race([m.signTransaction({ transaction: req.wire as never, inputPaths: req.inputPaths }), timeout]);
    if (res.error || !res.signedTransaction) throw new Error(res.error ?? 'empty response');
    return res.signedTransaction;
  }

  function onEvent(e: FlowEvent) {
    if (e.stage === 'lanes') board.value = e.board;
    if (e.stage === 'signing') { phase.value = 'signing'; activeLane.value = e.lane.outpoint; signingSend.value = e.send; signatures.value = e.attempt; }
    if (e.stage === 'broadcasting') phase.value = 'broadcasting';
    if (e.stage === 'waiting-lane') { phase.value = 'waiting-lane'; waitSeconds.value = e.secondsLeft; }
    if (e.stage === 'retrying') { phase.value = 'retrying'; activeLane.value = null; }
  }

  async function send(recipient: string, amount: bigint) {
    if (!wallet.value || phase.value !== 'idle' && phase.value !== 'done') return;
    notice.value = null;
    ticket.value = null;
    chosenLane.value = null;
    const spendableBefore = wallet.value.spendableBchSats;
    const coins = candidateCoins(wallet.value.coins, amount, config.params, new Set(pending.value ? [pending.value.in0] : []));
    try {
      const out = await runSend(
        { pool, params: config.params, categoryDisplay: config.categoryDisplay, lanesShown: config.lanes, provider, sign, store: localStore, onEvent },
        { coins, recipient, amount },
      );
      chosenLane.value = out.lane.outpoint;
      activeLane.value = null;
      await scan();
      ticket.value = computeTicket({
        txid: out.txid, hex: out.hex, proposed: out.proposed, categoryDisplay: config.categoryDisplay,
        userLock: lockingBytecodeOf(out.coin.owner.tokenAddress), poolLock,
        spendableBefore, spendableAfter: wallet.value?.spendableBchSats ?? null,
      });
      ticketLane.value = out.lane.number;
      localStore.clear();
      pending.value = null;
      phase.value = 'done';
      void refreshBoard();
    } catch (e) {
      activeLane.value = null;
      phase.value = 'idle';
      if (e instanceof FlowError) {
        notice.value = { code: e.code, message: e.message };
        if (e.pending) pending.value = e.pending;
      } else {
        notice.value = { code: 'CHAIN', message: (e as Error).message };
      }
      void refreshBoard();
    }
  }

  /** On load / second tab: never offer a fresh form for a coin that already has a signed version in flight. */
  async function resumePending() {
    const rec = localStore.load();
    if (!rec) return;
    if (Date.now() - rec.startedAt > PENDING_TTL_MS * 2) { localStore.clear(); return; }
    try {
      const st = await checkPending(provider, rec);
      if (st === 'seen') {
        showTicketFor(rec, null, null);
        localStore.clear();
      } else if (st === 'unknown') {
        pending.value = rec;
        notice.value = { code: 'PENDING', message: 'A send from this browser is still pending. Re-send the same signed transaction, or start over with the same coin (any new version spends the same coin, so only one can ever confirm).' };
      } else {
        localStore.clear();
      }
    } catch {
      pending.value = rec;
      notice.value = { code: 'PENDING', message: 'A send from this browser may still be pending; the server could not be reached to check it.' };
    }
  }

  function showTicketFor(rec: PendingSend, before: bigint | null, after: bigint | null) {
    const proposed = proposedFromPending(rec);
    ticket.value = computeTicket({
      txid: rec.txid, hex: rec.hex, proposed, categoryDisplay: config.categoryDisplay,
      userLock: proposed.sourceOutputs[0]!.lockingBytecode, poolLock, spendableBefore: before, spendableAfter: after,
    });
    ticketLane.value = rec.laneNumber;
    chosenLane.value = rec.laneOutpoint;
    phase.value = 'done';
  }

  async function resendPending() {
    const rec = pending.value;
    if (!rec) return;
    const r = await rebroadcast(provider, rec);
    if (r === 'ok') {
      showTicketFor(rec, null, null);
      localStore.clear();
      pending.value = null;
      notice.value = null;
      void refreshBoard();
    } else if (r === 'unknown') {
      notice.value = { code: 'BROADCAST_UNKNOWN', message: 'Still no answer from the server. The signed bytes are kept; try again shortly.' };
    } else {
      const st = await checkPending(provider, rec).catch(() => 'unknown' as const);
      if (st === 'seen') { showTicketFor(rec, null, null); localStore.clear(); pending.value = null; notice.value = null; return; }
      localStore.clear();
      pending.value = null;
      notice.value = st === 'superseded'
        ? { code: 'COIN_CHANGED', message: 'Your PUSD coin was spent by another transaction. Nothing more was signed.' }
        : { code: 'POOL_BUSY', message: 'That version was rejected (its lane was taken). Send again: the same coin is reused.' };
    }
  }

  function startOver() {
    localStore.clear();
    pending.value = null;
    notice.value = null;
    ticket.value = null;
    phase.value = 'idle';
  }

  return {
    wc, connected, provider, pool, height, chainError, board, boardError, wallet, scanning, maxUnits,
    phase, activeLane, chosenLane, signingSend, waitSeconds, signatures, notice, ticket, ticketLane, pending,
    refreshChain, refreshBoard, scan, send, resumePending, resendPending, startOver,
  };
}
