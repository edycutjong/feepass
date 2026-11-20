// Amounts, recipients, the mainnet config guard, the lane board rule and the wallet scan.
import { describe, expect, it } from 'vitest';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import { MockNetworkProvider, type SpendableUtxo } from 'cashscript';
import { formatUnits, parseRecipient, parseUnits, shortAddress } from '../src/core/amounts';
import { appPool, config, ConfigError, parseConfig } from '../src/core/config';
import raw from '../src/config/mainnet.json';
import gate from '../src/config/gate.json';
import { buildBoard, laneFloor, pickLane } from '../src/core/lanes';
import { candidateCoins, maxSendUnits, scanWallet } from '../src/core/walletScan';
import { lockingBytecodeOf } from '../src/core/dust';
import { DEFAULT_PARAMS } from '../src/core/params';
import { setup, key, CAT } from './helpers';

describe('amounts', () => {
  it.each([['1', 100n], ['1.5', 150n], ['1.50', 150n], ['.25', 25n], [' 0.01 ', 1n], ['12', 1200n]])('parseUnits(%s)', (s, v) => {
    expect(parseUnits(s)).toEqual({ ok: true, value: v });
  });
  it.each(['', '0', '0.00', '1.001', '-1', '1e2', '1,5', 'abc', '.', '1.2.3'])('parseUnits(%s) refuses', (s) => {
    expect(parseUnits(s).ok).toBe(false);
  });
  it('formatUnits', () => {
    expect(formatUnits(0n)).toBe('0.00');
    expect(formatUnits(1n)).toBe('0.01');
    expect(formatUnits(1240n)).toBe('12.40');
  });
});

describe('parseRecipient (mainnet P2PKH only)', () => {
  const pkh = hash160(key('r').pub);
  const q = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address;
  const z = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address;
  it('accepts q… and z… and a missing prefix, always returning the token-aware form', () => {
    expect(parseRecipient(q)).toEqual({ ok: true, value: z });
    expect(parseRecipient(z)).toEqual({ ok: true, value: z });
    expect(parseRecipient(z.slice('bitcoincash:'.length))).toEqual({ ok: true, value: z });
    expect(parseRecipient(q.toUpperCase())).toEqual({ ok: true, value: z });
  });
  it('refuses testnet, P2SH, bad checksum and junk', () => {
    expect(parseRecipient(key('r').address)).toMatchObject({ ok: false, reason: expect.stringMatching(/test-network/) });
    const p2sh = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2sh', payload: pkh }).address;
    expect(parseRecipient(p2sh)).toMatchObject({ ok: false, reason: expect.stringMatching(/Script addresses/) });
    expect(parseRecipient(z.slice(0, -1) + (z.endsWith('q') ? 'p' : 'q')).ok).toBe(false);
    expect(parseRecipient('hello').ok).toBe(false);
    expect(parseRecipient('').ok).toBe(false);
  });
  it('shortAddress keeps prefix, head and tail', () => {
    expect(shortAddress(z)).toMatch(/^bitcoincash:z.{5}….{6}$/);
  });
});

describe('config (mainnet guard, docs/ARCHITECTURE.md §4)', () => {
  it('parses the committed config: mainnet, fee and caps from the constructor', () => {
    expect(config.network).toBe('mainnet');
    expect(config.params).toEqual(DEFAULT_PARAMS);
    expect(config.lanes).toBeGreaterThanOrEqual(20);
    expect(config.explorerTx).toBe('https://bchexplorer.info/tx/');
  });
  it('refuses a config for any other network', () => {
    expect(() => parseConfig({ ...raw, network: 'chipnet' })).toThrow(ConfigError);
  });
  it('the app pool is the same contract the wallet-check page uses (same constructor)', () => {
    const p = new MockNetworkProvider();
    expect(config.ownerPk).toBe(gate.ownerPk);
    expect(config.categoryDisplay).toBe(gate.categoryDisplay);
    expect(appPool(config, p).tokenAddress.split(':')[1]!.startsWith('r')).toBe(true); // token-aware P2SH32
  });
  it('the preset recipient is a mainnet token-aware P2PKH address', () => {
    expect(parseRecipient(config.demoRecipient)).toEqual({ ok: true, value: config.demoRecipient });
  });
});

describe('lane board', () => {
  it('shows at most N heads (highest value first), counts the rest, and ignores non-lanes', () => {
    const s = setup();
    const lock = lockingBytecodeOf(s.pool.tokenAddress);
    for (let i = 0; i < 25; i++) s.addLane(100_000n + BigInt(i) * 10n);
    s.addLane(900_000n, 0n, null); // token-less donation
    s.addLane(2_000n); // below floor → closed, but outranked → not shown
    return s.provider.getUtxos(s.pool.tokenAddress).then((u) => {
      const b = buildBoard(u, { categoryDisplay: CAT, laneLock: lock, params: s.params, n: 20 });
      expect(b.lanes).toHaveLength(20);
      expect(b.lanes[0]!.valueSats).toBe(100_240n);
      expect(b.lanes.map((l) => l.number)).toEqual([...Array(20)].map((_, i) => i + 1));
      expect(b.otherCoins).toBe(7);
      expect(b.open).toBe(20);
    });
  });
  it('a lane below C + its own P2SH32 token dust is closed; a busy outpoint is busy', async () => {
    const s = setup();
    const lock = lockingBytecodeOf(s.pool.tokenAddress);
    const floor = laneFloor(CAT, lock, 1n, s.params);
    expect(floor).toBe(2000n + 681n);
    const a = s.addLane(floor - 1n);
    const b = s.addLane(floor);
    const c = s.addLane(floor + 10n);
    const board = buildBoard(await s.provider.getUtxos(s.pool.tokenAddress), { categoryDisplay: CAT, laneLock: lock, params: s.params, n: 20, busy: new Set([`${c.txid}:${c.vout}`]) });
    const st = Object.fromEntries(board.lanes.map((l) => [l.utxo.txid, l.state]));
    expect(st[a.txid]).toBe('closed');
    expect(st[b.txid]).toBe('open');
    expect(st[c.txid]).toBe('busy');
  });
  it('pickLane is uniform over open, non-excluded lanes and returns undefined when none is left', async () => {
    const s = setup();
    const lock = lockingBytecodeOf(s.pool.tokenAddress);
    for (let i = 0; i < 4; i++) s.addLane(100_000n + BigInt(i));
    const board = buildBoard(await s.provider.getUtxos(s.pool.tokenAddress), { categoryDisplay: CAT, laneLock: lock, params: s.params, n: 20 });
    expect(pickLane(board, new Set(), () => 0)!.number).toBe(1);
    expect(pickLane(board, new Set(), () => 0.999)!.number).toBe(4);
    expect(pickLane(board, new Set([board.lanes[0]!.outpoint]), () => 0)!.number).toBe(2);
    expect(pickLane(board, new Set(board.lanes.map((l) => l.outpoint)))).toBeUndefined();
  });
});

describe('wallet scan', () => {
  const a0 = (s: ReturnType<typeof setup>) => ({ pathName: 'receive', addressIndex: 0, address: s.user.address, tokenAddress: s.user.tokenAddress });
  it('PUSD coins (largest first), spendable BCH from non-token coins, NFTs and other tokens skipped', async () => {
    const s = setup();
    s.addUserCoin(30n); s.addUserCoin(120n);
    s.addUserCoin(0n, 5000n, null);
    s.addUserCoin(0n, 1000n, { category: CAT, amount: 5n, nft: { capability: 'none', commitment: '' } });
    s.addUserCoin(0n, 1000n, { category: 'ab'.repeat(32), amount: 9n });
    const w = await scanWallet(s.provider, [a0(s)], CAT);
    expect(w.coins.map((c) => c.token!.amount)).toEqual([120n, 30n]);
    expect(w.pusdUnits).toBe(150n);
    expect(w.spendableBchSats).toBe(5000n);
    expect(maxSendUnits(w.coins, s.params)).toBe(118n);
    expect(candidateCoins(w.coins, 29n, s.params).map((c) => c.token!.amount)).toEqual([120n]);
    expect(candidateCoins(w.coins, 28n, s.params)).toHaveLength(2);
  });
  it('a failed lookup makes spendable BCH unknown (null), never 0', async () => {
    const s = setup();
    s.addUserCoin(30n);
    const flaky = { getUtxos: async (addr: string): Promise<SpendableUtxo[]> => { if (addr === 'x') throw new Error('down'); return s.provider.getUtxos(addr); } };
    const w = await scanWallet(flaky, [a0(s), { pathName: 'change', addressIndex: 0, address: 'x', tokenAddress: 'x' }], CAT);
    expect(w.spendableBchSats).toBeNull();
    expect(w.failedLookups).toBe(1);
    expect(w.coins).toHaveLength(1);
  });
});
