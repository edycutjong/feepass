// @vitest-environment happy-dom
// The front screen: every figure it prints comes from evidence/tx-shape.json (and agrees with the mainnet config), the sample
// ticket says it is a sample, and the honest pool line follows the live board instead of being typed.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import shape from '../evidence/tx-shape.json';
import mainnet from '../src/config/mainnet.json';
import { measured, standardSend } from '../src/core/evidence';
import type { SpendableUtxo } from 'cashscript';
import type { Board, Lane } from '../src/core/lanes';
import SampleBooth from '../src/ui/SampleBooth.vue';
import FrontPage from '../src/ui/FrontPage.vue';

const emptyBoard: Board = { lanes: [], otherCoins: 0, open: 0, poolSats: 0n, poolUnits: 0n };
const props = { fee: '0.01', error: '', slots: 20, repoUrl: 'https://github.com/edycutjong/feepass' };

describe('measured figures', () => {
  it('picks the standard send (no top-up) and refuses an empty evidence file', () => {
    expect(standardSend().topUpSats).toBe(0);
    expect(standardSend().minerFeeSats).toBe(shape.sends.find((s) => s.topUpSats === 0)!.minerFeeSats);
    expect(() => standardSend([])).toThrow(/no measured sends/);
  });
  it('the evidence was measured with the constructor the app deploys', () => {
    expect(String(shape.params.maxSubsidy)).toBe(mainnet.constructor.maxSubsidy);
    expect(String(shape.params.maxTopUp)).toBe(mainnet.constructor.maxTopUp);
    expect(String(shape.params.feeTokens)).toBe(mainnet.constructor.feeTokens);
    expect(measured.maxSubsidySats).toBe(Number(mainnet.constructor.maxSubsidy));
  });
});

describe('SampleBooth', () => {
  it('prints the measured miner fee and size, labelled SAMPLE and not a mainnet send', () => {
    const w = mount(SampleBooth, { props: { fee: '0.01' } });
    expect(w.get('[data-testid=sample-miner]').text()).toBe(`${measured.send.minerFeeSats} sats`);
    expect(w.get('[data-testid=sample-size]').text()).toBe(`${measured.send.signedSizeBytes} bytes`);
    expect(w.get('[data-testid=sample-fee]').text()).toBe('0.01 PUSD');
    expect(w.text()).toContain('SAMPLE');
    expect(w.text()).toContain('Not a mainnet send.');
  });
  it('replay re-mounts the booth so the animation runs again', async () => {
    const w = mount(SampleBooth, { props: { fee: '0.01' } });
    const before = w.get('[data-testid=sample-booth]').element;
    await w.get('[data-testid=replay]').trigger('click');
    expect(w.get('[data-testid=sample-booth]').element).not.toBe(before);
  });
});

describe('FrontPage', () => {
  it('receipts come from the evidence file', () => {
    const w = mount(FrontPage, { props: { ...props, board: emptyBoard } });
    expect(w.findAll('[data-testid=receipt-num]').map((n) => n.text())).toEqual(
      ['0.01', ...[measured.send.minerFeeSats, measured.maxSubsidySats, measured.send.signedSizeBytes].map((n) => n.toLocaleString('en-US'))]);
  });
  it('unfunded pool: says the pool is not open and shows the honest not-funded line; the sample disclosure is always there', () => {
    const w = mount(FrontPage, { props: { ...props, board: emptyBoard } });
    expect(w.get('[data-testid=front-status]').text()).toContain('The pool is not open yet.');
    expect(w.find('[data-testid=honest-pool]').exists()).toBe(true);
    expect(w.text()).toContain('The ticket above is a sample');
  });
  it('the drain answer states the measured lane cost and that the total is not bounded', () => {
    const w = mount(FrontPage, { props: { ...props, board: emptyBoard } });
    const faq = w.findAll('details').map((d) => d.text()).find((t) => t.includes('draining'))!;
    expect(faq).toContain(`${measured.send.minerFeeSats} sats for a standard send`);
    expect(faq).toContain(String(measured.maxMeasuredSubsidySats));
    expect(faq).toContain('bounds each send, not the total');
  });
  it('board still loading or failed: no not-open claim either way', () => {
    const loading = mount(FrontPage, { props: { ...props, board: null } });
    expect(loading.get('[data-testid=front-status]').text()).toContain('Reading the pool');
    expect(loading.find('[data-testid=honest-pool]').exists()).toBe(false);
    expect(loading.text()).toContain('The ticket above is a sample');
    const failed = mount(FrontPage, { props: { ...props, board: null, error: 'timeout' } });
    expect(failed.get('[data-testid=front-status]').text()).toContain('Pool status unavailable');
    const stale = mount(FrontPage, { props: { ...props, board: emptyBoard, error: 'timeout' } });
    expect(stale.find('[data-testid=honest-pool]').exists()).toBe(false); // a failed refresh never re-asserts the old board
    expect(stale.text()).toContain('could not be read just now');
  });
  it('a funded pool drops the not-open line and counts open lanes', () => {
    const utxo: SpendableUtxo = { txid: 'aa'.repeat(32), vout: 0, satoshis: 100_000n, lockingBytecode: '' } as SpendableUtxo;
    const lane: Lane = { number: 1, outpoint: `${utxo.txid}:0`, utxo, valueSats: 100_000n, pusdUnits: 1n, state: 'open' };
    const board: Board = { ...emptyBoard, lanes: [lane], open: 1 };
    const w = mount(FrontPage, { props: { ...props, board } });
    expect(w.get('[data-testid=front-status]').text()).toContain('1 of 1 lanes open.');
    expect(w.find('[data-testid=honest-pool]').exists()).toBe(false);
  });
  it('the hero button asks to connect', async () => {
    const w = mount(FrontPage, { props: { ...props, board: emptyBoard } });
    await w.get('[data-testid=hero-connect]').trigger('click');
    expect(w.emitted('connect')).toHaveLength(1);
  });
});
