// @vitest-environment happy-dom
// The judged screens without a wallet: the send form's validation and its three-output preview (built from a real
// transaction), the ticket's lines and headline rules, and the lane board's states.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ElectrumNetworkProvider, type SpendableUtxo } from 'cashscript';
import { binToHex, encodeCashAddress, hash160 } from '@bitauth/libauth';
import SendForm from '../src/ui/SendForm.vue';
import TicketCard from '../src/ui/TicketCard.vue';
import LaneBoard from '../src/ui/LaneBoard.vue';
import { appPool, config } from '../src/core/config';
import { lockingBytecodeOf } from '../src/core/dust';
import { buildBoard } from '../src/core/lanes';
import { scanWallet, maxSendUnits } from '../src/core/walletScan';
import type { Ticket } from '../src/core/receipt';
import { setup, key, CAT } from './helpers';

// The real mainnet pool (same constructor as production). Its provider is never asked anything: the form builds offline.
const mainnetPool = appPool(config, new ElectrumNetworkProvider('mainnet'));
const userPkh = hash160(key('form-user').pub);
const userTok = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: userPkh }).address;
const userAddr = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: userPkh }).address;

async function formRig(units = 100n) {
  const lanes: SpendableUtxo[] = [0, 1, 2].map((k) => ({ txid: 'aa'.repeat(32), vout: k, satoshis: 100_000n + BigInt(k), token: { category: CAT, amount: 1n }, lockingBytecode: mainnetPool.lockingBytecode }));
  const coin: SpendableUtxo = { txid: 'bb'.repeat(32), vout: 0, satoshis: 1000n, token: { category: CAT, amount: units }, lockingBytecode: binToHex(lockingBytecodeOf(userTok)) };
  const wallet = await scanWallet({ getUtxos: async (a) => (a === userAddr ? [coin] : []) }, [{ pathName: 'receive', addressIndex: 0, address: userAddr, tokenAddress: userTok }], CAT);
  const board = buildBoard(lanes, { categoryDisplay: CAT, laneLock: lockingBytecodeOf(mainnetPool.tokenAddress), params: config.params, n: 20 });
  return mount(SendForm, { props: { cfg: config, wallet, board, pool: mainnetPool, maxUnits: maxSendUnits(wallet.coins, config.params), busy: false } });
}

describe('SendForm', () => {
  it('preset fills the faucet address and 0.10 PUSD, and the preview lists the 3 outputs from the built tx', async () => {
    const w = await formRig();
    await w.get('[data-testid=preset]').trigger('click');
    expect((w.get('#to').element as HTMLInputElement).value).toBe(config.demoRecipient);
    expect((w.get('#amt').element as HTMLInputElement).value).toBe('0.10');
    const out = w.get('[data-testid=wallet-outputs]').text();
    expect(out).toContain('0.10');
    expect(out).toContain('0.89 → you'); // 1.00 − 0.10 − 0.01 fee
    expect(out).toContain('0.02 → the pool'); // lane seed 0.01 + fee 0.01
    expect(w.get('[data-testid=send]').text()).toBe('Send 0.10 PUSD');
    expect(w.get('[data-testid=send]').attributes('disabled')).toBeUndefined();
  });
  it('amount above the largest coin names the limit; a testnet address is refused; send stays disabled', async () => {
    const w = await formRig();
    await w.get('#to').setValue('bchtest:qq0000000000000000000000000000000000000000');
    await w.get('#to').trigger('blur');
    await w.get('#amt').setValue('5');
    expect(w.text()).toMatch(/at most 0\.98 PUSD/);
    expect(w.text()).toMatch(/test-network address|Not a valid/);
    expect(w.get('[data-testid=send]').attributes('disabled')).toBeDefined();
  });
  it('emits the token-aware recipient and base units on submit', async () => {
    const w = await formRig();
    await w.get('[data-testid=preset]').trigger('click');
    await w.get('form').trigger('submit');
    expect(w.emitted('send')?.[0]).toEqual([config.demoRecipient, 10n]);
  });
});

const T: Ticket = {
  txid: 'ab'.repeat(32), headline: 'No spendable BCH used.', inputs: { userCoin: true, poolLane: true, count: 2 },
  recipient: config.demoRecipient, sentUnits: 10n, feeUnits: 1n, poolSubsidySats: 580n, minerFeeSats: 580n, topUpSats: 0n,
  coinSatsBefore: 1000n, coinSatsAfter: 349n, sizeBytes: 572, spendableBefore: 0n, spendableAfter: 0n, balanceUnchanged: true,
};

describe('TicketCard', () => {
  it('prints every line from the ticket, the explorer link, the headline and F4 line', () => {
    const w = mount(TicketCard, { props: { ticket: T, lane: 14, explorerTx: config.explorerTx, fee: '0.01', at: '2026-11-18 14:02 UTC' } });
    const t = w.text();
    expect(t).toContain('Lane 14');
    expect(t).toContain('0.10 PUSD →');
    expect(t).toContain('0.01 PUSD (to the pool)');
    expect(t).toContain('580 sats');
    expect(t).toContain('0.00000000 → 0.00000000');
    expect(t).toContain('1000 → 349');
    expect(w.get('a').attributes('href')).toBe(config.explorerTx + T.txid);
    expect(w.get('[data-testid=headline]').text()).toBe('No spendable BCH used.');
    expect(t).toContain("Your BCH balance didn't change.");
    expect(t).not.toMatch(/zero BCH|binds recipient|gasless/i);
  });
  it('no headline and no F4 line when the tx or the snapshots do not support them', () => {
    const w = mount(TicketCard, { props: { ticket: { ...T, headline: null, spendableAfter: null, balanceUnchanged: false }, lane: 3, explorerTx: config.explorerTx, fee: '0.01', at: '' } });
    expect(w.find('[data-testid=headline]').exists()).toBe(false);
    expect(w.text()).not.toContain("didn't change");
    expect(w.text()).toContain('0.00000000 → unknown');
  });
});

describe('LaneBoard', () => {
  it('unfunded pool: N unlit heads and an honest caption; live board: chosen head is paid, active head busy', async () => {
    const empty = mount(LaneBoard, { props: { board: null, error: '', active: null, chosen: null, slots: 20 } });
    expect(empty.findAll('.head.dark')).toHaveLength(20);
    const s = setup();
    const a = s.addLane(100_002n), b = s.addLane(100_001n);
    s.addLane(1_000n);
    const board = buildBoard(await s.provider.getUtxos(s.pool.tokenAddress), { categoryDisplay: CAT, laneLock: lockingBytecodeOf(s.pool.tokenAddress), params: s.params, n: 20 });
    const w = mount(LaneBoard, { props: { board, error: '', active: `${b.txid}:${b.vout}`, chosen: `${a.txid}:${a.vout}`, slots: 20 } });
    expect(w.findAll('.head').map((h) => h.attributes('aria-label'))).toEqual(['Lane 1 paid', 'Lane 2 busy', 'Lane 3 closed']);
    expect(w.text()).toContain('2 of 3 lanes open'); // the caption counts chain state; the 1,000-sat lane is closed
  });
});

