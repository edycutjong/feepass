// App state for the FeePass screens: WizardConnect session, wallet scan, live lane board, the send, the ticket, and the one
// pending-send record. All chain logic lives in src/core; this file only wires it to Vue refs.
import { computed, ref, shallowRef, watch } from 'vue';
import { useWizardConnect } from '@paytaca/wizardconnect-vue';
import { ElectrumNetworkProvider } from 'cashscript';
import { parseRecipient } from '../core/amounts';
import { appPool, config } from '../core/config';
import { lockingBytecodeOf } from '../core/dust';
import { deriveAddresses } from '../core/hdAddresses';
import { buildBoard, type Board } from '../core/lanes';
import { computeTicket, type Ticket } from '../core/receipt';
import {
  checkPending, FlowError, PENDING_TTL_MS, proposedFromPending, rebroadcast, RelayTimeoutError, runSend,
  type FlowErrorCode, type FlowEvent, type PendingSend, type PendingStore,
} from '../core/sendFlow';
import type { SponsoredSend } from '../core/sponsoredSend';
import { candidateCoins, maxSendUnits, scanWallet, type WalletScan } from '../core/walletScan';
import type { WizardSignRequest } from '../core/wizard';

const SIGN_TIMEOUT_MS = 180_000;
const PENDING_KEY = 'feepass.pending.v1';

export const localStore: PendingStore = {
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

export type Phase = 'idle' | 'starting' | 'signing' | 'broadcasting' | 'waiting-lane' | 'retrying' | 'done';
export interface Notice { code: FlowErrorCode | 'PENDING' | 'SCAN' | 'CHAIN' | 'BAD_RECIPIENT'; message: string }

const utcStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function useFeePass(opts: { store?: PendingStore; signTimeoutMs?: number } = {}) {
  const store = opts.store ?? localStore;
  // Mainnet only: the provider is built with 'mainnet' and there is no network switch (architecture §9.2).
  const provider = new ElectrumNetworkProvider('mainnet');
  const pool = appPool(config, provider);
  const poolLock = lockingBytecodeOf(pool.tokenAddress);

  const wc = useWizardConnect({ dappName: 'FeePass', persistSession: true });
  const connected = computed(() => wc.state.value === 'connected');

  const height = ref<number | null>(null);
  const chainError = ref('');
  const board = shallowRef<Board | null>(null);
  const boardError = ref('');
  const wallet = shallowRef<WalletScan | null>(null);
  const scanning = ref(false);

  const phase = ref<Phase>('idle');
  const resuming = ref(true);
  const activeLane = ref<string | null>(null);
  const chosenLane = ref<string | null>(null);
  const signingSend = shallowRef<SponsoredSend | null>(null);
  const waitSeconds = ref(0);
  const signatures = ref(0);
  const retryReason = ref<string | null>(null);
  const notice = shallowRef<Notice | null>(null);
  const ticket = shallowRef<Ticket | null>(null);
  const ticketLane = ref<number | null>(null);
  const ticketAt = ref('');
  /** Set on every successful broadcast, even if the ticket cannot be computed: the explorer link always shows. */
  const sentTxid = ref<string | null>(null);
  const pending = shallowRef<PendingSend | null>(null);
  let inFlight = false;

  async function refreshChain() {
    try {
      height.value = await provider.getBlockHeight();
      chainError.value = '';
    } catch (e) {
      chainError.value = (e as Error).message;
    }
  }

  /** The board freezes while a ticket is shown, so the paid head stays green above it (ui.md S4). */
  async function refreshBoard(force = false) {
    if (!force && sentTxid.value) return;
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

  /** Returns the fresh scan, or null if it failed (callers must not reuse a stale snapshot as a measurement). */
  async function scan(): Promise<WalletScan | null> {
    if (!wc.manager.value) return null;
    scanning.value = true;
    try {
      const w = await scanWallet(provider, addresses(), config.categoryDisplay);
      wallet.value = w;
      return w;
    } catch (e) {
      notice.value = { code: 'SCAN', message: (e as Error).message };
      return null;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new RelayTimeoutError('No answer from the wallet within 3 minutes.')), opts.signTimeoutMs ?? SIGN_TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([m.signTransaction({ transaction: req.wire as never, inputPaths: req.inputPaths }), timeout]);
      if (res.error || !res.signedTransaction) throw new Error(res.error ?? 'empty response');
      return res.signedTransaction;
    } finally {
      clearTimeout(timer);
    }
  }

  function onEvent(e: FlowEvent) {
    if (e.stage === 'lanes') board.value = e.board;
    if (e.stage === 'signing') { phase.value = 'signing'; activeLane.value = e.lane.outpoint; signingSend.value = e.send; signatures.value = e.attempt; }
    if (e.stage === 'broadcasting') phase.value = 'broadcasting';
    if (e.stage === 'waiting-lane') { phase.value = 'waiting-lane'; waitSeconds.value = e.secondsLeft; }
    if (e.stage === 'retrying') { phase.value = 'retrying'; activeLane.value = null; retryReason.value = e.reason; }
  }

  function showTicket(o: { txid: string; hex: string; proposed: ReturnType<typeof proposedFromPending>; ownerAddress: string; laneOutpoint: string; laneNumber: number; before: bigint | null; after: bigint | null; at: string }) {
    sentTxid.value = o.txid;
    chosenLane.value = o.laneOutpoint;
    ticketLane.value = o.laneNumber;
    ticketAt.value = o.at;
    try {
      ticket.value = computeTicket({
        txid: o.txid, hex: o.hex, proposed: o.proposed, categoryDisplay: config.categoryDisplay,
        userLock: lockingBytecodeOf(o.ownerAddress), poolLock, spendableBefore: o.before, spendableAfter: o.after,
      });
    } catch {
      ticket.value = null; // the send landed; the fallback card shows the txid and explorer link
    }
    phase.value = 'done';
  }

  async function send(recipientInput: string, amount: bigint) {
    if (inFlight || resuming.value || !wallet.value || pending.value) return;
    inFlight = true;
    phase.value = 'starting'; // synchronous: a second click sees busy before any await
    try {
      notice.value = null;
      ticket.value = null;
      sentTxid.value = null;
      chosenLane.value = null;
      retryReason.value = null;
      const r = parseRecipient(recipientInput);
      if (!r.ok) { notice.value = { code: 'BAD_RECIPIENT', message: r.reason }; phase.value = 'idle'; return; }
      const spendableBefore = wallet.value.spendableBchSats;
      const coins = candidateCoins(wallet.value.coins, amount, config.params);
      const out = await runSend(
        { pool, params: config.params, categoryDisplay: config.categoryDisplay, lanesShown: config.lanes, provider, sign, store, onEvent },
        { coins, recipient: r.value, amount },
      );
      store.clear(); // the send landed: the record has done its job, whatever the ticket below does
      activeLane.value = null;
      const after = await scan();
      showTicket({
        txid: out.txid, hex: out.hex, proposed: out.proposed, ownerAddress: out.coin.owner.address, laneOutpoint: out.lane.outpoint,
        laneNumber: out.lane.number, before: spendableBefore, after: after ? after.spendableBchSats : null, at: utcStamp(),
      });
    } catch (e) {
      activeLane.value = null;
      phase.value = 'idle';
      if (e instanceof FlowError) {
        notice.value = { code: e.code, message: e.message };
        if (e.pending) pending.value = e.pending;
        if (e.code === 'SEND_IN_PROGRESS') await resumePending();
      } else {
        notice.value = { code: 'CHAIN', message: (e as Error).message };
      }
      void refreshBoard(true);
    } finally {
      inFlight = false;
    }
  }

  function ticketFromRecord(rec: PendingSend) {
    showTicket({
      txid: rec.txid, hex: rec.hex, proposed: proposedFromPending(rec), ownerAddress: rec.ownerAddress,
      laneOutpoint: rec.laneOutpoint, laneNumber: rec.laneNumber, before: null, after: null, at: `${utcStamp()} (recovered)`,
    });
    store.clear();
    pending.value = null;
  }

  /** On load / second tab: never offer a fresh form for a coin that already has a signed version in flight. */
  async function resumePending() {
    try {
      const rec = store.load();
      if (!rec) return;
      if (Date.now() - rec.startedAt > PENDING_TTL_MS * 2) { store.clear(); return; }
      let st: Awaited<ReturnType<typeof checkPending>> | 'offline';
      try { st = await checkPending(provider, rec); } catch { st = 'offline'; }
      if (st === 'seen') ticketFromRecord(rec);
      else if (st === 'unknown' || st === 'offline') {
        pending.value = rec;
        notice.value = {
          code: 'PENDING',
          message: st === 'offline'
            ? 'A send from this browser may still be pending; the server could not be reached to check it.'
            : 'A send from this browser is still pending. Re-send the same signed transaction, or start over with the same coin (any new version spends the same coin, so only one can ever confirm).',
        };
      } else store.clear();
    } finally {
      resuming.value = false;
    }
  }

  async function resendPending() {
    const rec = pending.value;
    if (!rec) return;
    const r = await rebroadcast(provider, rec);
    if (r === 'ok') { ticketFromRecord(rec); notice.value = null; return; }
    if (r === 'unknown' || r === 'missing-inputs') {
      notice.value = { code: 'BROADCAST_UNKNOWN', message: r === 'unknown'
        ? 'Still no answer from the server. The signed bytes are kept; try again shortly.'
        : 'The pool lane is still propagating to this server. The signed bytes are kept; try again in a few seconds.' };
      return;
    }
    const st = await checkPending(provider, rec).catch(() => 'unknown' as const);
    if (st === 'seen') { ticketFromRecord(rec); notice.value = null; return; }
    store.clear();
    pending.value = null;
    notice.value = st === 'superseded'
      ? { code: 'COIN_CHANGED', message: 'Your PUSD coin was spent by another transaction. Nothing more was signed.' }
      : { code: 'POOL_BUSY', message: 'That version was rejected (its lane was taken). Send again: the same coin is reused.' };
  }

  /** Checks first: if the pending version already landed, show its ticket instead of starting a conflicting send. */
  async function startOver() {
    const rec = pending.value ?? store.load();
    if (rec) {
      const st = await checkPending(provider, rec).catch(() => 'unknown' as const);
      if (st === 'seen') { ticketFromRecord(rec); notice.value = null; return; }
    }
    store.clear();
    pending.value = null;
    notice.value = null;
    ticket.value = null;
    sentTxid.value = null;
    chosenLane.value = null;
    phase.value = 'idle';
    void refreshBoard(true);
    void scan();
  }

  return {
    wc, connected, provider, pool, height, chainError, board, boardError, wallet, scanning, maxUnits, resuming,
    phase, activeLane, chosenLane, signingSend, waitSeconds, signatures, retryReason, notice, ticket, ticketLane, ticketAt, sentTxid, pending,
    refreshChain, refreshBoard, scan, send, resumePending, resendPending, startOver,
  };
}
