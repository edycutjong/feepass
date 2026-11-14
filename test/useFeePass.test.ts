// @vitest-environment happy-dom
// The app composable with a fake WizardConnect session (a conforming signer behind real xpub derivation) and a mock chain
// that answers as 'mainnet': double-submit, the ticket after a real send, the frozen board, resume and start-over.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, sha256, utf8ToBin } from '@bitauth/libauth';

const h = vi.hoisted(() => ({ chain: null as any, manager: null as any, signCalls: 0 }));

vi.mock('cashscript', async (orig) => {
  const m = await orig<typeof import('cashscript')>();
  class MainnetMock extends m.MockNetworkProvider { constructor() { super(); (this as any).network = 'mainnet'; } }
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
});
