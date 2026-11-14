// The sponsored send, end to end: pick a lane → build the fixed shape → wallet signs input 0 → verify → broadcast → recover.
// Recovery (architecture §3): every re-sign of one send keeps the SAME in0, so two versions of one payment conflict on the
// user's coin and at most one can ever confirm. A lane conflict or script rejection excludes that lane and asks for one more
// signature (max 2, then "Pool busy"). A missing lane parent is waited for (≤ 20 s) before moving on. If the user's own coin
// is gone, the flow stops by name. A broadcast with no answer is "status unknown": the same bytes may be re-sent, never re-signed.
import { stringify } from '@bitauth/libauth';
import { parseExtendedJson } from '@wizardconnect/core';
import type { Contract, SpendableUtxo, WcTransactionObject } from 'cashscript';
import { lockingBytecodeOf } from './dust';
import { buildBoard, outpointOf, pickLane, type Board, type Lane } from './lanes';
import type { PoolParams } from './params';
import { buildSponsoredSend, SendError, type SponsoredSend } from './sponsoredSend';
import type { UserCoin } from './walletScan';
import { toWizardRequest, verifySignedTx, VerifyError, type VerifiedTx, type WizardSignRequest } from './wizard';

export type FlowErrorCode =
  | 'NO_COIN'
  | 'POOL_EMPTY'
  | 'POOL_BUSY'
  | 'WALLET_REJECTED'
  | 'RELAY_TIMEOUT'
  | 'SEND_IN_PROGRESS'
  | 'NONCONFORMANT_SIGHASH'
  | 'WALLET_CHANGED_TX'
  | 'COIN_CHANGED'
  | 'BROADCAST_UNKNOWN';

export class FlowError extends Error {
  constructor(public code: FlowErrorCode, message: string, public pending?: PendingSend) {
    super(message);
    this.name = 'FlowError';
  }
}

/** One record in localStorage (architecture §4): written before the first broadcast, cleared when settled. */
export interface PendingSend {
  in0: string;
  ownerAddress: string;
  txid: string;
  hex: string;
  laneOutpoint: string;
  laneNumber: number;
  excluded: string[];
  startedAt: number;
  /** The proposed WC object in extended-JSON form: the receipt reads its source outputs. */
  proposed: string;
}

export const PENDING_TTL_MS = 30 * 60 * 1000;

/** Thrown by a signer that got no answer from the wallet in time; the session (and its QR) stays valid for a retry. */
export class RelayTimeoutError extends Error {
  constructor(message = 'No answer from the wallet in time.') {
    super(message);
    this.name = 'RelayTimeoutError';
  }
}

export interface PendingStore {
  load(): PendingSend | null;
  save(p: PendingSend): void;
  clear(): void;
}

export function memoryStore(): PendingStore {
  let v: PendingSend | null = null;
  return { load: () => v, save: (p) => (v = p), clear: () => (v = null) };
}

export interface FlowProvider {
  getUtxos(address: string): Promise<SpendableUtxo[]>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string): Promise<string>;
}

export type FlowEvent =
  | { stage: 'lanes'; board: Board }
  | { stage: 'signing'; lane: Lane; attempt: number; send: SponsoredSend }
  | { stage: 'broadcasting'; lane: Lane; txid: string }
  | { stage: 'waiting-lane'; lane: Lane; secondsLeft: number }
  | { stage: 'retrying'; lane: Lane; reason: 'lane-conflict' | 'lane-rejected' | 'lane-missing'; attempt: number };

export interface FlowDeps {
  pool: Contract<any, any, 'p2sh32'>;
  params: PoolParams;
  categoryDisplay: string;
  lanesShown: number;
  provider: FlowProvider;
  sign(req: WizardSignRequest): Promise<string>;
  store?: PendingStore;
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onEvent?: (e: FlowEvent) => void;
  /** Extra signatures after the first, per send (ui.md: "after 2 re-signs: Pool busy"). */
  maxResigns?: number;
  /** How long to wait for an unconfirmed lane parent to reach the server (ui.md: up to 20 s). */
  laneWaitMs?: number;
}

export interface SendRequest {
  coins: UserCoin[];
  recipient: string;
  amount: bigint;
}

export interface SendSuccess {
  txid: string;
  hex: string;
  verified: VerifiedTx;
  lane: Lane;
  send: SponsoredSend;
  coin: UserCoin;
  proposed: WcTransactionObject;
  signatures: number;
}

export type BroadcastFailure = 'already-known' | 'conflict' | 'missing-inputs' | 'script' | 'fee' | 'unknown';

/** Maps a node / Fulcrum rejection to the recovery branch. No answer at all (timeout, socket) is 'unknown'. */
export function classifyBroadcastError(message: string): BroadcastFailure {
  const m = message.toLowerCase();
  if (/already in (the )?block ?chain|txn-already-known|txn-already-in-mempool|already have transaction/.test(m)) return 'already-known';
  if (/txn-mempool-conflict|mempool conflict|double.?spend/.test(m)) return 'conflict';
  if (/missing.?inputs|missingorspent|inputs.?missing/.test(m)) return 'missing-inputs';
  if (/min relay fee|insufficient (priority|fee)|fee not met/.test(m)) return 'fee';
  if (/script|bad-txns|scriptsig|non-final|dust|invalid/.test(m)) return 'script';
  return 'unknown';
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function coinUnspent(p: FlowProvider, ownerAddress: string, outpoint: string): Promise<boolean> {
  const utxos = await p.getUtxos(ownerAddress);
  return utxos.some((u) => outpointOf(u) === outpoint);
}

export async function readBoard(d: FlowDeps, busy?: ReadonlySet<string>): Promise<Board> {
  const utxos = await d.provider.getUtxos(d.pool.tokenAddress);
  return buildBoard(utxos, { categoryDisplay: d.categoryDisplay, laneLock: lockingBytecodeOf(d.pool.tokenAddress), params: d.params, n: d.lanesShown, busy });
}

export async function runSend(d: FlowDeps, r: SendRequest): Promise<SendSuccess> {
  const maxResigns = d.maxResigns ?? 2;
  const sleep = d.sleep ?? defaultSleep;
  const now = d.now ?? Date.now;
  const store = d.store ?? memoryStore();
  // One send per coin at a time, across tabs: a stored record means a signed version may be in flight.
  if (store.load()) throw new FlowError('SEND_IN_PROGRESS', 'A send from this browser is still pending. Resolve it first (re-send the same transaction or start over).');
  if (r.coins.length === 0) throw new FlowError('NO_COIN', 'None of your PUSD coins can carry this amount plus the fee and 0.01 PUSD change.');
  const excluded = new Set<string>();
  let coin: UserCoin | undefined;
  let signatures = 0;
  let board = await readBoard(d);
  d.onEvent?.({ stage: 'lanes', board });

  for (;;) {
    const lane = pickLane(board, excluded, d.rng);
    if (!lane) {
      if (signatures > 0) throw new FlowError('POOL_BUSY', 'Every lane we tried was taken. Try again in a minute.');
      throw new FlowError('POOL_EMPTY', board.lanes.length ? 'All lanes are closed: the pool is refilling.' : 'The pool has no open lanes yet.');
    }

    // Choose in0 once; every later version of this send spends the same coin.
    let send: SponsoredSend | undefined;
    let lastCoinError = '';
    for (const c of coin ? [coin] : r.coins) {
      try {
        send = buildSponsoredSend({
          pool: d.pool, params: d.params, categoryDisplay: d.categoryDisplay,
          userUtxo: c, userAddress: c.owner.tokenAddress, lane: lane.utxo, recipient: r.recipient, amount: r.amount,
        });
        coin = c;
        break;
      } catch (e) {
        if (e instanceof SendError && (e.code === 'LANE_TOO_SMALL' || e.code === 'LANE_NOT_PUSD' || e.code === 'SUBSIDY_EXCEEDS_CAP')) {
          excluded.add(lane.outpoint);
          send = undefined;
          lastCoinError = '';
          break;
        }
        lastCoinError = errText(e);
      }
    }
    if (!send) {
      if (lastCoinError) throw new FlowError('NO_COIN', lastCoinError);
      continue; // lane unusable for this shape: pick another without asking for a signature
    }
    const c = coin!;

    signatures++;
    d.onEvent?.({ stage: 'signing', lane, attempt: signatures, send });
    const req = toWizardRequest(send, { pathName: c.owner.pathName, addressIndex: c.owner.addressIndex }, 'FeePass: send PUSD, the pool pays the BCH network fee');
    let signedHex: string;
    try {
      signedHex = await d.sign(req);
    } catch (e) {
      if (e instanceof RelayTimeoutError) throw new FlowError('RELAY_TIMEOUT', `${e.message} Nothing was sent; press Send to ask again (the wallet stays connected).`);
      throw new FlowError('WALLET_REJECTED', `The wallet did not sign: ${errText(e)}. Nothing was sent.`);
    }
    let verified: VerifiedTx;
    try {
      verified = verifySignedTx(signedHex, req.proposed, lockingBytecodeOf(c.owner.tokenAddress));
    } catch (e) {
      if (e instanceof VerifyError && e.code === 'SIGHASH') throw new FlowError('NONCONFORMANT_SIGHASH', `This wallet's signature can't be used: ${e.message}`);
      throw new FlowError('WALLET_CHANGED_TX', `${errText(e)} Nothing was broadcast.`);
    }

    const pending: PendingSend = {
      in0: outpointOf(c), ownerAddress: c.owner.address, txid: verified.txid, hex: verified.hex,
      laneOutpoint: lane.outpoint, laneNumber: lane.number, excluded: [...excluded], startedAt: now(), proposed: stringify(req.proposed),
    };
    store.save(pending);
    d.onEvent?.({ stage: 'broadcasting', lane, txid: verified.txid });

    const outcome = await broadcastOnce(d, pending, lane, sleep);
    if (outcome === 'ok') {
      return { txid: verified.txid, hex: verified.hex, verified, lane, send, coin: c, proposed: req.proposed, signatures };
    }
    if (outcome === 'coin-changed') {
      store.clear();
      throw new FlowError('COIN_CHANGED', 'Your PUSD coin was spent by another transaction while this send was pending. Nothing more was signed.');
    }
    if (outcome === 'unknown') throw new FlowError('BROADCAST_UNKNOWN', 'The server did not answer. The same signed bytes can be re-sent safely.', pending);

    // Lane failure: exclude it, refresh the board, ask for one more signature if allowed.
    store.clear();
    excluded.add(lane.outpoint);
    if (signatures > maxResigns) throw new FlowError('POOL_BUSY', 'Pool busy: try again in a minute.');
    d.onEvent?.({ stage: 'retrying', lane, reason: outcome as 'lane-conflict' | 'lane-rejected' | 'lane-missing', attempt: signatures });
    board = await readBoard(d, excluded);
    d.onEvent?.({ stage: 'lanes', board });
  }
}

type Outcome = 'ok' | 'coin-changed' | 'unknown' | 'lane-conflict' | 'lane-rejected' | 'lane-missing';

async function broadcastOnce(d: FlowDeps, p: PendingSend, lane: Lane, sleep: (ms: number) => Promise<void>): Promise<Outcome> {
  const waitMs = d.laneWaitMs ?? 20_000;
  let waited = 0;
  for (;;) {
    let failure: BroadcastFailure;
    try {
      await d.provider.sendRawTransaction(p.hex);
      return 'ok';
    } catch (e) {
      failure = classifyBroadcastError(errText(e));
    }
    if (failure === 'already-known') return 'ok';
    if (failure === 'unknown') return 'unknown';
    if (failure === 'script' || failure === 'fee') return 'lane-rejected';
    // conflict or missing inputs: whose input is it?
    let mine: boolean;
    try {
      mine = await coinUnspent(d.provider, p.ownerAddress, p.in0);
    } catch {
      return 'unknown';
    }
    if (!mine) return 'coin-changed';
    if (failure === 'conflict') return 'lane-conflict';
    // Missing inputs with our coin intact. The lane was picked from THIS server's own UTXO list (same provider), so if that
    // list no longer holds it, it was spent: move on. Otherwise its unconfirmed parent may still be propagating: wait
    // (ticking each second) and re-send the same bytes every 5 s, up to the window.
    if (waited >= waitMs) return 'lane-missing';
    try {
      const poolUtxos = await d.provider.getUtxos(d.pool.tokenAddress);
      if (poolUtxos.length > 0 && !poolUtxos.some((u) => outpointOf(u) === lane.outpoint)) return 'lane-conflict';
    } catch {
      /* cannot tell: keep waiting */
    }
    const until = Math.min(waited + 5_000, waitMs);
    while (waited < until) {
      d.onEvent?.({ stage: 'waiting-lane', lane, secondsLeft: Math.ceil((waitMs - waited) / 1000) });
      await sleep(1_000);
      waited += 1_000;
    }
  }
}

export type PendingStatus = 'seen' | 'unknown' | 'superseded' | 'expired';

/** On reload / second tab: has the pending send landed, is it still re-sendable, or did another tx spend its coin? */
const NOT_FOUND = /no such (mempool or blockchain )?transaction|not found|unknown transaction|missing transaction/i;

/** Throws if the server cannot be asked (callers treat that as "offline", never as an answer). */
export async function checkPending(p: FlowProvider, rec: PendingSend, now = Date.now()): Promise<PendingStatus> {
  try {
    if (await p.getRawTransaction(rec.txid)) return 'seen';
  } catch (e) {
    if (!NOT_FOUND.test(errText(e))) throw e; // a transient error is not "not found": a landed send must not read as superseded
  }
  if (now - rec.startedAt > PENDING_TTL_MS) return 'expired';
  return (await coinUnspent(p, rec.ownerAddress, rec.in0)) ? 'unknown' : 'superseded';
}

/** Re-send the SAME signed bytes (never a fresh signature). */
export async function rebroadcast(p: FlowProvider, rec: PendingSend): Promise<'ok' | BroadcastFailure> {
  try {
    await p.sendRawTransaction(rec.hex);
    return 'ok';
  } catch (e) {
    const f = classifyBroadcastError(errText(e));
    return f === 'already-known' ? 'ok' : f;
  }
}

export function proposedFromPending(rec: PendingSend): WcTransactionObject {
  return parseExtendedJson(rec.proposed) as WcTransactionObject;
}

