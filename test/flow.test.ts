// End-to-end sponsored send on the mock chain: lane pick → build → conforming signer (sighash 0x61) → VM verify → broadcast →
// ticket, plus every recovery branch of architecture §3 (F2 retry on txn-mempool-conflict, same in0 on every re-sign).
import { describe, expect, it } from 'vitest';
import { binToHex, decodeTransaction, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { signWcTransaction } from '../src/core/headlessSigner';
import { lockingBytecodeOf } from '../src/core/dust';
import {
  checkPending, classifyBroadcastError, FlowError, memoryStore, proposedFromPending, rebroadcast, runSend,
  type FlowDeps, type FlowEvent, type FlowProvider,
} from '../src/core/sendFlow';
import { computeTicket } from '../src/core/receipt';
import { scanWallet, candidateCoins, type UserCoin } from '../src/core/walletScan';
import type { WizardSignRequest } from '../src/core/wizard';
import { setup, CAT, pusd } from './helpers';

type S = ReturnType<typeof setup>;
const owner = (s: S) => ({ pathName: 'receive', addressIndex: 0, address: s.user.address, tokenAddress: s.user.tokenAddress });

function rig(s: S, o: { failures?: string[]; sighash?: number; tamper?: boolean; reject?: boolean; onSend?: () => void } = {}) {
  const failures = [...(o.failures ?? [])];
  const sent: string[] = [];
  const signedIn0: string[] = [];
  const provider: FlowProvider = {
    getUtxos: (a) => s.provider.getUtxos(a),
    getRawTransaction: (t) => s.provider.getRawTransaction(t),
    async sendRawTransaction(hex) {
      o.onSend?.();
      const f = failures.shift();
      if (f) throw new Error(f);
      sent.push(hex);
      return s.provider.sendRawTransaction(hex);
    },
  };
  const events: FlowEvent[] = [];
  const store = memoryStore();
  const deps: FlowDeps = {
    pool: s.pool, params: s.params, categoryDisplay: CAT, lanesShown: 20, provider, store,
    sleep: async () => {}, onEvent: (e) => events.push(e),
    async sign(req: WizardSignRequest) {
      if (o.reject) throw new Error('User rejected');
      const t = req.proposed.transaction;
      signedIn0.push(`${binToHex(t.inputs[0]!.outpointTransactionHash)}:${t.inputs[0]!.outpointIndex}`);
      let hex = signWcTransaction(req.wire, new Map([[0, s.user.priv]]), o.sighash);
      if (o.tamper) {
        const tx = decodeTransaction(hexToBin(hex)) as Exclude<ReturnType<typeof decodeTransaction>, string>;
        tx.outputs[0]!.valueSatoshis += 1n;
        hex = binToHex(encodeTransaction(tx));
      }
      return hex;
    },
  };
  return { deps, sent, events, store, signedIn0 };
}

async function coins(s: S): Promise<UserCoin[]> {
  const scan = await scanWallet(s.provider, [owner(s)], CAT);
  return candidateCoins(scan.coins, 10n, s.params);
}

describe('runSend (mock chain, conforming signer)', () => {
  it('happy path: one signature, VM-verified, broadcast, ticket reads the tx', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.addLane(100_000n + BigInt(i));
    s.addUserCoin(100n, 1000n);
    const r = rig(s);
    const before = (await scanWallet(s.provider, [owner(s)], CAT)).spendableBchSats;
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.signatures).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(out.verified.sighashType).toBe(0x61);
    const after = (await scanWallet(s.provider, [owner(s)], CAT)).spendableBchSats;
    const t = computeTicket({
      txid: out.txid, hex: out.hex, proposed: out.proposed, categoryDisplay: CAT,
      userLock: lockingBytecodeOf(s.user.tokenAddress), poolLock: lockingBytecodeOf(s.pool.tokenAddress),
      spendableBefore: before, spendableAfter: after,
    });
    expect(t.headline).toBe('No spendable BCH used.');
    expect(t.sentUnits).toBe(10n);
    expect(t.feeUnits).toBe(1n);
    expect(t.poolSubsidySats).toBe(out.send.poolSubsidySats);
    expect(t.minerFeeSats).toBe(out.send.minerFeeSats);
    expect(t.topUpSats).toBe(out.send.topUpSats);
    expect(t.coinSatsBefore).toBe(1000n);
    expect(t.balanceUnchanged).toBe(true);
    expect(t.spendableBefore).toBe(0n);
    // the ticket prints the recipient as a mainnet token-aware address with the same locking script
    expect(t.recipient.startsWith('bitcoincash:z')).toBe(true);
    expect(binToHex(lockingBytecodeOf(t.recipient))).toBe(binToHex(s.payee.lock));
  });

  it('F2: txn-mempool-conflict on the first lane → another lane, one more signature, SAME in0', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) s.addLane(100_000n + BigInt(i));
    s.addUserCoin(100n, 1000n);
    const r = rig(s, { failures: ['the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)'] });
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.signatures).toBe(2);
    expect(new Set(r.signedIn0).size).toBe(1);
    const lanes = r.events.filter((e) => e.stage === 'signing').map((e) => (e as { lane: { outpoint: string } }).lane.outpoint);
    expect(lanes[0]).not.toBe(lanes[1]);
    expect(r.events.some((e) => e.stage === 'retrying')).toBe(true);
  });

  it('three conflicts in a row → POOL_BUSY after 3 signatures (max 2 re-signs)', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) s.addLane(100_000n + BigInt(i));
    s.addUserCoin(100n, 1000n);
    const c = 'txn-mempool-conflict';
    const r = rig(s, { failures: [c, c, c] });
    await expect(runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'POOL_BUSY' });
    expect(r.signedIn0).toHaveLength(3);
    expect(new Set(r.signedIn0).size).toBe(1);
  });

  it('conflict on the user coin (spent elsewhere) → COIN_CHANGED, no re-sign', async () => {
    const s = setup();
    s.addLane();
    const coin = s.addUserCoin(100n, 1000n);
    const cs = await coins(s);
    const r = rig(s, { failures: ['txn-mempool-conflict'], onSend: () => { (s.provider as any).utxoSet = (s.provider as any).utxoSet.filter(([, u]: any) => u.txid !== coin.txid); } });
    await expect(runSend(r.deps, { coins: cs, recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'COIN_CHANGED' });
    expect(r.signedIn0).toHaveLength(1);
    expect(r.store.load()).toBeNull();
  });

  it('missing inputs with the user coin intact → waits for the lane parent, then the same bytes land', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const r = rig(s, { failures: ['bad-txns-inputs-missingorspent', 'Missing inputs'] });
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.signatures).toBe(1);
    expect(r.events.filter((e) => e.stage === 'waiting-lane')).toHaveLength(2);
  });

  it('missing inputs past the 20 s wait → another lane', async () => {
    const s = setup();
    s.addLane(100_000n); s.addLane(100_001n);
    s.addUserCoin(100n, 1000n);
    const m = 'Missing inputs';
    const r = rig(s, { failures: [m, m, m, m, m] });
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.signatures).toBe(2);
  });

  it('no answer from the server → BROADCAST_UNKNOWN with the pending record kept; rebroadcast sends the same bytes', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const r = rig(s, { failures: ['Request timed out'] });
    const err = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n }).catch((e) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect(err.code).toBe('BROADCAST_UNKNOWN');
    const rec = r.store.load()!;
    expect(rec.txid).toBe(err.pending.txid);
    expect(await checkPending(r.deps.provider, rec)).toBe('unknown');
    expect(await rebroadcast(r.deps.provider, rec)).toBe('ok');
    expect(r.sent[0]).toBe(rec.hex);
    expect(await checkPending(r.deps.provider, rec)).toBe('seen');
    expect(proposedFromPending(rec).sourceOutputs).toHaveLength(2);
  });

  it('a stale pending record expires after 30 min', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const r = rig(s, { failures: ['socket closed'] });
    await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n }).catch(() => {});
    const rec = r.store.load()!;
    expect(await checkPending(r.deps.provider, rec, rec.startedAt + 31 * 60_000)).toBe('expired');
  });

  it('wallet refuses → WALLET_REJECTED, nothing broadcast', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const r = rig(s, { reject: true });
    await expect(runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'WALLET_REJECTED' });
    expect(r.sent).toHaveLength(0);
  });

  it('sighash 0x41 → NONCONFORMANT_SIGHASH; a changed output → WALLET_CHANGED_TX; neither broadcasts', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const a = rig(s, { sighash: 0x41 });
    await expect(runSend(a.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'NONCONFORMANT_SIGHASH' });
    const b = rig(s, { tamper: true });
    await expect(runSend(b.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'WALLET_CHANGED_TX' });
    expect(a.sent.length + b.sent.length).toBe(0);
  });

  it('empty pool → POOL_EMPTY; only closed lanes → POOL_EMPTY "refilling"; no lane asks for a signature', async () => {
    const s = setup();
    s.addUserCoin(100n, 1000n);
    const r = rig(s);
    await expect(runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'POOL_EMPTY', message: expect.stringMatching(/no open lanes/) });
    s.addLane(2_500n);
    await expect(runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'POOL_EMPTY', message: expect.stringMatching(/refilling/) });
    expect(r.signedIn0).toHaveLength(0);
  });

  it('token-less and NFT coins at the pool address are never picked as lanes', async () => {
    const s = setup();
    s.addLane(500_000n, 0n, null);
    s.addLane(400_000n, 0n, { category: CAT, amount: 0n, nft: { capability: 'none', commitment: '' } });
    const lane = s.addLane(100_000n);
    s.addUserCoin(100n, 1000n);
    const r = rig(s);
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.lane.outpoint).toBe(`${lane.txid}:${lane.vout}`);
  });

  it('a coin too thin in sats is skipped for one that fits; none fits → NO_COIN naming the reason', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 100n); // 100 sats: needs > T top-up
    const r = rig(s);
    await expect(runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'NO_COIN', message: expect.stringMatching(/top-up/) });
    const good = s.addUserCoin(50n, 1000n);
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    expect(out.coin.txid).toBe(good.txid);
  });

  it('no candidate coin at all → NO_COIN without touching the pool', async () => {
    const s = setup();
    s.addLane();
    const r = rig(s);
    await expect(runSend(r.deps, { coins: [], recipient: s.payee.tokenAddress, amount: 10n })).rejects.toMatchObject({ code: 'NO_COIN' });
  });
});

describe('classifyBroadcastError', () => {
  it.each([
    ['txn-mempool-conflict (code 18)', 'conflict'],
    ['bad-txns-inputs-missingorspent', 'missing-inputs'],
    ['Missing inputs', 'missing-inputs'],
    ['mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)', 'script'],
    ['min relay fee not met', 'fee'],
    ['txn-already-known', 'already-known'],
    ['Transaction already in block chain', 'already-known'],
    ['Request timed out', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (msg, want) => expect(classifyBroadcastError(msg)).toBe(want));
});

describe('ticket honesty', () => {
  it('no headline when input 0 is not the user coin', async () => {
    const s = setup();
    s.addLane();
    s.addUserCoin(100n, 1000n);
    const r = rig(s);
    const out = await runSend(r.deps, { coins: await coins(s), recipient: s.payee.tokenAddress, amount: 10n });
    const t = computeTicket({
      txid: out.txid, hex: out.hex, proposed: out.proposed, categoryDisplay: CAT,
      userLock: lockingBytecodeOf(s.payee.tokenAddress), poolLock: lockingBytecodeOf(s.pool.tokenAddress),
      spendableBefore: 0n, spendableAfter: null,
    });
    expect(t.headline).toBeNull();
    expect(t.balanceUnchanged).toBe(false); // unknown after-snapshot is never "unchanged"
  });
});

void pusd;
