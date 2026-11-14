// @vitest-environment happy-dom
// The app composable with a fake WizardConnect session (a conforming signer behind real xpub derivation) and a mock chain
// that answers as 'mainnet': double-submit, the ticket after a real send, the frozen board, resume and start-over.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, sha256, utf8ToBin } from '@bitauth/libauth';

const h = vi.hoisted(() => ({ chain: null as any, manager: null as any, signCalls: 0 }));

vi.mock('cashscript', async (orig) => {
  const m = await orig<typeof import('cashscript')>();
  class MainnetMock extends m.MockNetworkProvider {
    constructor() { super(); (this as any).network = 'mainnet'; }
    // Fulcrum throws for an unknown txid (the plain mock returns undefined): answer like the real server.
    async getRawTransaction(txid: string) { const r = await super.getRawTransaction(txid); if (!r) throw new Error('No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'); return r; }
  }
  return { ...m, ElectrumNetworkProvider: class { constructor() { if (!h.chain) h.chain = new MainnetMock(); return h.chain; } } };
});
vi.mock('@paytaca/wizardconnect-vue', async () => {
  const { ref } = await import('vue');
  return { useWizardConnect: () => ({ state: ref('connected'), manager: ref(h.manager), walletName: ref('Test wallet'), uri: ref(null), qrUri: ref(null), connect: () => true, disconnect: async () => {}, error: ref(null) }) };
});

import { randomUtxo } from 'cashscript';
import { signWcTransaction } from '../src/core/headlessSigner';
import { deriveAddresses } from '../src/core/hdAddresses';
import { config } from '../src/core/config';
import { memoryStore } from '../src/core/sendFlow';
import { useFeePass } from '../src/ui/useFeePass';

const root = deriveHdPrivateNodeFromSeed(sha256.hash(utf8ToBin('feepass composable test')));
const receive = deriveHdPrivateNodeChild(root, 0);
const xpub = encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(receive) }).hdPublicKey;
const userPriv = deriveHdPrivateNodeChild(receive, 0).privateKey;
const me = deriveAddresses([{ name: 'receive', xpub }])[0]!;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.chain = null;
  h.signCalls = 0;
  h.manager = {
    getSessionPaths: () => [{ name: 'receive', xpub }],
    signTransaction: async ({ transaction }: { transaction: unknown }) => { h.signCalls++; await tick(); return { signedTransaction: signWcTransaction(transaction, new Map([[0, userPriv]])) }; },
  };
});

function fund(fp: ReturnType<typeof useFeePass>, lanes = 3) {
  for (let i = 0; i < lanes; i++) h.chain.addUtxo(fp.pool.tokenAddress, randomUtxo({ satoshis: 100_000n + BigInt(i), token: { category: config.categoryDisplay, amount: 1n } }));
  h.chain.addUtxo(me.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: config.categoryDisplay, amount: 100n } }));
}

describe('useFeePass', () => {
  it('a double click signs once; the ticket reads the tx; the paid head stays on a frozen board', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    expect(fp.wallet.value!.pusdUnits).toBe(100n);
    const a = fp.send(config.demoRecipient, 10n);
    const b = fp.send(config.demoRecipient, 10n); // second click while the first is in flight
    await Promise.all([a, b]);
    expect(h.signCalls).toBe(1);
    expect(fp.notice.value).toBeNull();
    expect(fp.ticket.value!.headline).toBe('No spendable BCH used.');
    expect(fp.ticket.value!.balanceUnchanged).toBe(true);
    expect(fp.ticketAt.value).toMatch(/UTC$/);
    expect(store.load()).toBeNull();
    const chosen = fp.chosenLane.value;
    expect(fp.board.value!.lanes.some((l) => l.outpoint === chosen)).toBe(true);
    await fp.refreshBoard(); // frozen while the ticket shows
    expect(fp.board.value!.lanes.some((l) => l.outpoint === chosen)).toBe(true);
  });

  it('the form is blocked until the pending check has run (resuming)', async () => {
    const fp = useFeePass({ store: memoryStore() });
    fund(fp);
    await fp.scan();
    expect(fp.resuming.value).toBe(true);
    await fp.send(config.demoRecipient, 10n);
    expect(h.signCalls).toBe(0);
  });

  it('status unknown → reload resumes the record → re-send lands → ticket; start over after a landed send shows its ticket', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    expect(fp.notice.value!.code).toBe('BROADCAST_UNKNOWN');
    expect(store.load()).not.toBeNull();

    // reload: a fresh composable on the same store
    h.chain.sendRawTransaction = real;
    const fp2 = useFeePass({ store });
    await fp2.resumePending();
    expect(fp2.notice.value!.code).toBe('PENDING');
    expect(fp2.pending.value).not.toBeNull();
    await fp2.resendPending();
    expect(fp2.ticket.value!.headline).toBe('No spendable BCH used.');
    expect(fp2.ticketAt.value).toMatch(/recovered/);
    expect(store.load()).toBeNull();
  });

  it('start over checks first: a pending version that already landed shows its ticket instead of a conflicting send', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    let n = 0;
    h.chain.sendRawTransaction = async (hex: string) => { n++; await real(hex); throw new Error('socket closed'); }; // lands, answer lost
    await fp.send(config.demoRecipient, 10n);
    expect(fp.notice.value!.code).toBe('BROADCAST_UNKNOWN');
    h.chain.sendRawTransaction = real;
    await fp.startOver();
    expect(fp.ticket.value).not.toBeNull();
    expect(n).toBe(1);
  });

  it('a failed post-send scan gives an unknown after-snapshot, never a fake "unchanged"', async () => {
    const fp = useFeePass({ store: memoryStore() });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    const getUtxos = h.chain.getUtxos.bind(h.chain);
    h.chain.sendRawTransaction = async (hex: string) => {
      const r = await real(hex);
      h.chain.getUtxos = async (a: string) => { if (a === me.address) throw new Error('down'); return getUtxos(a); };
      return r;
    };
    await fp.send(config.demoRecipient, 10n);
    expect(fp.ticket.value!.spendableAfter).toBeNull();
    expect(fp.ticket.value!.balanceUnchanged).toBe(false);
  });

  it('a corrupt stored record is cleared, never a permanent block', async () => {
    const store = memoryStore();
    store.save({ txid: 'nope' } as never);
    const fp = useFeePass({ store });
    await fp.resumePending();
    expect(store.load()).toBeNull();
    expect(fp.resuming.value).toBe(false);
    expect(fp.notice.value).toBeNull();
  });

  it('start over with the server unreachable keeps the record (a landed send must not be forgotten)', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    h.chain.getRawTransaction = async () => { throw new Error('connection reset'); };
    await fp.startOver();
    expect(store.load()).not.toBeNull();
    expect(fp.notice.value!.code).toBe('PENDING');
    void real;
  });

  it("second tab: a send while another tab's version already landed shows that ticket and no stale notice", async () => {
    const store = memoryStore();
    const tabA = useFeePass({ store });
    fund(tabA);
    await tabA.resumePending();
    await tabA.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async (hex: string) => { await real(hex); throw new Error('socket closed'); }; // lands, answer lost
    await tabA.send(config.demoRecipient, 10n);
    h.chain.sendRawTransaction = real;
    // tab C opened before A's record existed (its resume found nothing), then tries to send on the shared store
    const tabC = useFeePass({ store });
    tabC.resuming.value = false;
    await tabC.scan();
    await tabC.send(config.demoRecipient, 10n);
    expect(tabC.ticket.value).not.toBeNull();
    expect(tabC.notice.value).toBeNull();
    expect(store.load()).toBeNull();
  });

  it('a re-send rejected for a fee reason says so, not "lane taken"', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    h.chain.sendRawTransaction = async () => { throw new Error('min relay fee not met'); };
    await fp.resendPending();
    expect(fp.notice.value!.message).toMatch(/rejected that version \(fee\)/);
    expect(fp.notice.value!.message).not.toMatch(/taken/);
  });

  it('a record older than an hour whose tx landed still shows its ticket (the chain is asked first)', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async (hex: string) => { await real(hex); throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    h.chain.sendRawTransaction = real;
    store.save({ ...store.load()!, startedAt: Date.now() - 61 * 60_000 });
    const later = useFeePass({ store });
    await later.resumePending();
    expect(later.ticket.value).not.toBeNull();
    expect(store.load()).toBeNull();
  });

  it('an expired record that never landed is discarded with a notice, not silently', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    store.save({ ...store.load()!, startedAt: Date.now() - 31 * 60_000 });
    const later = useFeePass({ store });
    await later.resumePending();
    expect(later.notice.value!.code).toBe('DISCARDED');
    expect(store.load()).toBeNull();
  });

  it('while tab A waits on the wallet, tab B cannot ask for a second signature (signing lock)', async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sign0 = h.manager.signTransaction;
    h.manager.signTransaction = async (x: unknown) => { await gate; return sign0(x); };
    const tabA = useFeePass({ store });
    fund(tabA);
    await tabA.resumePending();
    await tabA.scan();
    const a = tabA.send(config.demoRecipient, 10n);
    for (let i = 0; i < 10 && !store.getLock(); i++) await tick();
    expect(store.getLock()).not.toBeNull();
    const tabB = useFeePass({ store });
    await tabB.resumePending();
    await tabB.scan();
    await tabB.send(config.demoRecipient, 10n);
    expect(tabB.notice.value!.code).toBe('SEND_IN_PROGRESS');
    release();
    await a;
    expect(tabA.ticket.value).not.toBeNull();
    expect(store.getLock()).toBeNull();
    expect(h.signCalls).toBe(1);
  });

  it('start over after an unknown broadcast pins the coin: the next send must reuse it until its old lane is spent', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp); // one user coin: 100 units
    await fp.resumePending();
    await fp.scan();
    const real = h.chain.sendRawTransaction.bind(h.chain);
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    expect(fp.notice.value!.code).toBe('BROADCAST_UNKNOWN');
    const in0 = store.load()!.in0;
    h.chain.sendRawTransaction = real;
    await fp.startOver();
    expect(store.load()).toBeNull();
    expect(store.getPin()!.in0).toBe(in0);
    // a bigger coin arrives; a send only it can carry is refused while the old version could still confirm
    h.chain.addUtxo(me.tokenAddress, randomUtxo({ satoshis: 1400n, token: { category: config.categoryDisplay, amount: 500n } }));
    await fp.scan();
    await fp.send(config.demoRecipient, 200n);
    expect(fp.notice.value!.code).toBe('NO_COIN');
    expect(fp.notice.value!.message).toMatch(/reuse its coin/);
    expect(h.signCalls).toBe(1);
    // once the old version's lane is gone it can never confirm: the pin lifts and the other coin is used
    store.setPin({ ...store.getPin()!, laneOutpoint: '00'.repeat(32) + ':0' });
    await fp.send(config.demoRecipient, 200n);
    expect(fp.ticket.value).not.toBeNull();
    expect(store.getPin()).toBeNull();
  });

  it('two tabs past the first check at once: the second re-checks right before the wallet prompt and stops', async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sign0 = h.manager.signTransaction;
    h.manager.signTransaction = async (x: unknown) => { await gate; return sign0(x); };
    const tabA = useFeePass({ store });
    fund(tabA);
    const tabB = useFeePass({ store });
    for (const t of [tabA, tabB]) { await t.resumePending(); await t.scan(); }
    const a = tabA.send(config.demoRecipient, 10n);
    const b = tabB.send(config.demoRecipient, 10n); // same tick: neither saw a lock at its first check
    await b;
    expect(tabB.notice.value!.code).toBe('SEND_IN_PROGRESS');
    release();
    await a;
    expect(tabA.ticket.value).not.toBeNull();
    expect(h.signCalls).toBe(1);
  });

  it("a tab releases only its own signing lock, never another tab's", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sign0 = h.manager.signTransaction;
    h.manager.signTransaction = async (x: unknown) => { await gate; return sign0(x); };
    const tabA = useFeePass({ store });
    fund(tabA);
    await tabA.resumePending();
    await tabA.scan();
    const a = tabA.send(config.demoRecipient, 10n);
    for (let i = 0; i < 10 && !store.getLock(); i++) await tick();
    const foreign = { in0: 'aa'.repeat(32) + ':1', at: Date.now(), id: 'another-tab' };
    store.setLock(foreign); // another tab took the lock (e.g. after a stale-lock takeover)
    release();
    await a;
    expect(store.getLock()).toEqual(foreign);
  });

  it('a re-send answered "missing inputs" after the coin was spent elsewhere says the coin changed', async () => {
    const store = memoryStore();
    const fp = useFeePass({ store });
    fund(fp);
    await fp.resumePending();
    await fp.scan();
    h.chain.sendRawTransaction = async () => { throw new Error('socket closed'); };
    await fp.send(config.demoRecipient, 10n);
    const in0 = store.load()!.in0.split(':')[0];
    h.chain.utxoSet = h.chain.utxoSet.filter(([, u]: any) => u.txid !== in0);
    h.chain.sendRawTransaction = async () => { throw new Error('bad-txns-inputs-missingorspent'); };
    await fp.resendPending();
    expect(fp.notice.value!.code).toBe('COIN_CHANGED');
    expect(store.load()).toBeNull();
  });

  it("clear(txid) never removes another tab's record", () => {
    const store = memoryStore();
    store.save({ txid: 'a'.repeat(64) } as never);
    store.clear('b'.repeat(64));
    expect(store.load()).not.toBeNull();
    store.clear('a'.repeat(64));
    expect(store.load()).toBeNull();
  });
  it('starter claim: posts the first receive address, then rescans until the coin shows', async () => {
    const fp = useFeePass({ store: memoryStore() });
    await fp.scan();
    expect(fp.wallet.value!.coins).toHaveLength(0);
    const calls: { url: string; body: any }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      h.chain.addUtxo(me.tokenAddress, randomUtxo({ satoshis: 1400n, token: { category: config.categoryDisplay, amount: 25n } })); // the faucet's coin lands in the mempool
      return new Response(JSON.stringify({ txid: 'ab'.repeat(32), units: 25 }), { status: 200 });
    }) as unknown as typeof fetch;
    await fp.claimStarterPusd(fetcher, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/feepass?op=starter');
    expect(calls[0]!.body.address).toBe(me.tokenAddress);
    expect(fp.starter.value).toMatchObject({ state: 'sent', txid: 'ab'.repeat(32) });
    expect(fp.wallet.value!.pusdUnits).toBe(25n);
  });

  it('starter claim: the server’s refusal is shown as it is (code kept); a network failure is named; no repeat while one is running', async () => {
    const fp = useFeePass({ store: memoryStore() });
    await fp.scan();
    const refuse = (async () => new Response(JSON.stringify({ error: 'This address already claimed its starter PUSD.', code: 'ALREADY_CLAIMED' }), { status: 409 })) as unknown as typeof fetch;
    await fp.claimStarterPusd(refuse, 1);
    expect(fp.starter.value).toMatchObject({ state: 'error', code: 'ALREADY_CLAIMED', message: 'This address already claimed its starter PUSD.' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await fp.claimStarterPusd(down, 1);
    expect(fp.starter.value).toMatchObject({ state: 'error', code: 'NETWORK' });
    let n = 0;
    const slow = (async () => { n++; await new Promise((r) => setTimeout(r, 20)); return new Response('{}', { status: 503 }); }) as unknown as typeof fetch;
    await Promise.all([fp.claimStarterPusd(slow, 1), fp.claimStarterPusd(slow, 1)]);
    expect(n).toBe(1);
  });
});
