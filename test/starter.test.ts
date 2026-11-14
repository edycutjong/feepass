// Starter PUSD faucet: every rule from the one serverless function, offline on a mainnet-answering mock chain.
import { describe, expect, it } from 'vitest';
import { binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hexToBin, sha256, utf8ToBin, secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type SpendableUtxo } from 'cashscript';
import { FundedMock, fundingTxHex } from './helpers';
import { claimStarter, pickClaimCoins, readFaucetCoins, STARTER_DEFAULTS, StarterError, type FaucetChain, type StarterConfig } from '../src/core/starter';
import { PUSD_CATEGORY_DISPLAY as CAT } from '../src/core/params';
import { dustFor, lockingBytecodeOf } from '../src/core/dust';

function mainnetKey(seed: string) {
  const priv = sha256.hash(utf8ToBin(seed));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  return {
    priv, pub,
    address: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address,
  };
}

class Chain extends FundedMock implements FaucetChain {
  sent: string[] = [];
  failNext: string[] = [];
  /** Runs once, just before the next scripted failure: a competing claim that wins the race. */
  beforeFail?: () => Promise<unknown>;
  height = 1000;
  blockTimes = new Map<string, number>(); // txid → unix seconds (absent = mempool)
  constructor() { super(); (this as any).network = 'mainnet'; }
  async sendRawTransaction(hex: string) {
    const f = this.failNext.shift();
    if (f) {
      const competitor = this.beforeFail;
      this.beforeFail = undefined;
      if (competitor) await competitor();
      throw new Error(f);
    }
    const txid = await super.sendRawTransaction(hex);
    this.sent.push(txid);
    return txid;
  }
  calls: string[] = [];
  async history() { this.calls.push('history'); return this.sent.map((txid) => ({ txid, height: this.blockTimes.has(txid) ? 990 : 0 })); }
  async getUtxos(address: string) { this.calls.push('utxos'); return super.getUtxos(address); }
  async tipHeight() { return this.height; }
  async blockTime() { return Math.floor(NOW / 1000) - 3 * 86_400; }
}
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function setup(o: { coins?: bigint[]; bch?: bigint; cfg?: Partial<StarterConfig> } = {}) {
  const faucet = mainnetKey('faucet');
  const chain = new Chain();
  for (const u of o.coins ?? [300n]) chain.addUtxo(faucet.tokenAddress, randomUtxo({ satoshis: 2000n, token: { category: CAT, amount: u } }));
  if (o.bch !== 0n) chain.addUtxo(faucet.tokenAddress, randomUtxo({ satoshis: o.bch ?? 50_000n }));
  const cfg: StarterConfig = {
    category: CAT, faucetPriv: faucet.priv, faucetPub: faucet.pub, faucetAddress: faucet.address, faucetTokenAddress: faucet.tokenAddress,
    ...STARTER_DEFAULTS, now: () => NOW, ...o.cfg,
  };
  return { faucet, chain, cfg };
}
const judge = (n: number) => mainnetKey('judge' + n).tokenAddress;

describe('starter claim', () => {
  it('sends the starter amount with ≥ 2 token dust, returns PUSD change to the faucet (no burn) and BCH change', async () => {
    const { chain, cfg, faucet } = setup();
    const r = await claimStarter(chain, cfg, judge(1));
    expect(r.units).toBe(25n);
    const tx = decodeTransaction(hexToBin(await chain.getRawTransaction(r.txid)));
    if (typeof tx === 'string') throw new Error(tx);
    const toJudge = tx.outputs[0]!;
    expect(binToHex(toJudge.lockingBytecode)).toBe(binToHex(lockingBytecodeOf(judge(1))));
    expect(toJudge.token!.amount).toBe(25n);
    expect(toJudge.valueSatoshis).toBeGreaterThanOrEqual(2n * dustFor(toJudge.lockingBytecode, { category: CAT, amount: 25n }));
    const pusdOut = tx.outputs.reduce((s, o) => s + (o.token ? o.token.amount : 0n), 0n);
    expect(pusdOut).toBe(300n); // conserved
    expect(binToHex(tx.outputs[1]!.lockingBytecode)).toBe(binToHex(lockingBytecodeOf(faucet.tokenAddress)));
    expect(r.feeSats).toBeGreaterThan(200n);
    expect(r.feeSats).toBeLessThan(600n);
  });

  it('one claim per receiving address, from the faucet’s own history', async () => {
    const { chain, cfg } = setup();
    await claimStarter(chain, cfg, judge(1));
    await expect(claimStarter(chain, cfg, judge(1))).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    // the plain q… spelling of the same key is the same address
    const q = mainnetKey('judge1').address;
    await expect(claimStarter(chain, cfg, q)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    await expect(claimStarter(chain, cfg, judge(2))).resolves.toBeTruthy();
  });

  it('caps public claims per UTC day (default 3)', async () => {
    const { chain, cfg } = setup({ coins: [300n] });
    for (let i = 0; i < 3; i++) await claimStarter(chain, cfg, judge(10 + i));
    await expect(claimStarter(chain, cfg, judge(20))).rejects.toMatchObject({ code: 'DAILY_CAP' });
  });

  it('claims confirmed on an earlier UTC day do not use today’s slots, but still lock their address', async () => {
    const { chain, cfg } = setup({ coins: [300n], cfg: { dailyCap: 1 } });
    const r = await claimStarter(chain, cfg, judge(1));
    chain.blockTimes.set(r.txid, 1); // confirmed at height 990, three days before NOW
    await expect(claimStarter(chain, cfg, judge(2))).resolves.toBeTruthy(); // yesterday's claim does not count
    await expect(claimStarter(chain, cfg, judge(1))).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    await expect(claimStarter(chain, cfg, judge(3))).rejects.toMatchObject({ code: 'DAILY_CAP' });
  });

  it('an inbound send to the faucet (the preset recipient) is not a claim: no daily slot, no address lock', async () => {
    const { chain, cfg, faucet } = setup({ cfg: { dailyCap: 1 } });
    const j = mainnetKey('payer');
    const coin = chain.addUtxo(j.tokenAddress, randomUtxo({ satoshis: 1500n, token: { category: CAT, amount: 40n } }));
    const bch = chain.addUtxo(j.tokenAddress, randomUtxo({ satoshis: 5000n }));
    const signer = new SignatureTemplate(j.priv).unlockP2PKH();
    await new TransactionBuilder({ provider: chain })
      .addInputs([coin, bch], signer)
      .addOutput({ to: faucet.tokenAddress, amount: 1000n, token: { category: CAT, amount: 10n } })
      .addOutput({ to: j.tokenAddress, amount: 1000n, token: { category: CAT, amount: 30n } })
      .addOutput({ to: j.address, amount: 2500n })
      .send();
    // the payer sent to the faucet; they can still claim, and the daily slot is still free
    await expect(claimStarter(chain, cfg, j.tokenAddress)).resolves.toBeTruthy();
  });

  it('combines several small faucet coins when none covers a claim (returned 0.10 coins stay claimable)', async () => {
    const { chain, cfg } = setup({ coins: [10n, 10n, 10n] });
    const r = await claimStarter(chain, cfg, judge(1));
    const tx = decodeTransaction(hexToBin(await chain.getRawTransaction(r.txid)));
    if (typeof tx === 'string') throw new Error(tx);
    expect(tx.inputs.length).toBe(4); // three PUSD coins + one BCH coin
    expect(tx.outputs[0]!.token!.amount).toBe(25n);
    expect(tx.outputs[1]!.token!.amount).toBe(5n);
    const units = (await readFaucetCoins(chain, cfg)).units;
    expect(units).toBe(5n);
  });

  it('empty faucet, no BCH for the fee, bad and self addresses → named errors, nothing broadcast', async () => {
    const a = setup({ coins: [20n] });
    await expect(claimStarter(a.chain, a.cfg, judge(1))).rejects.toMatchObject({ code: 'FAUCET_EMPTY' });
    const c = setup({ bch: 0n });
    // a faucet whose only coin barely carries the starter output + change has nothing left for the network fee
    const d = new Chain();
    const f = mainnetKey('faucet');
    d.addUtxo(f.tokenAddress, randomUtxo({ satoshis: 1500n, token: { category: CAT, amount: 300n } }));
    await expect(claimStarter(d, c.cfg, judge(1))).rejects.toMatchObject({ code: 'FAUCET_NO_BCH' });
    await expect(claimStarter(a.chain, a.cfg, 'bchtest:qq1234')).rejects.toMatchObject({ code: 'BAD_ADDRESS' });
    await expect(claimStarter(a.chain, a.cfg, a.faucet.tokenAddress)).rejects.toMatchObject({ code: 'SELF' });
    expect(a.chain.sent).toHaveLength(0);
  });

  it('retries on txn-mempool-conflict with a fresh read, gives up with BUSY, and does not retry other failures', async () => {
    const a = setup();
    a.chain.failNext = ['txn-mempool-conflict'];
    await expect(claimStarter(a.chain, a.cfg, judge(1))).resolves.toBeTruthy();
    const b = setup();
    b.chain.failNext = ['txn-mempool-conflict', 'txn-mempool-conflict', 'txn-mempool-conflict'];
    await expect(claimStarter(b.chain, b.cfg, judge(1))).rejects.toMatchObject({ code: 'BUSY' });
    const c = setup();
    c.chain.failNext = ['bad-txns-in-belowout'];
    await expect(claimStarter(c.chain, c.cfg, judge(1))).rejects.toMatchObject({ code: 'CHAIN' });
    expect(c.chain.failNext).toHaveLength(0); // one attempt only
  });

  it('refuses a configuration whose starter output is below 2 × token dust, before any broadcast', async () => {
    const { chain, cfg } = setup({ cfg: { starterSats: 900n } });
    await expect(claimStarter(chain, cfg, judge(1))).rejects.toMatchObject({ code: 'DUST' });
    expect(chain.sent).toHaveLength(0);
  });

  it('pickClaimCoins: the largest single covering coin (deterministic, so concurrent claims collide), else largest-first, else nothing', () => {
    const c = (u: bigint) => randomUtxo({ satoshis: 1000n, token: { category: CAT, amount: u } }) as SpendableUtxo;
    const a = [c(30n), c(40n), c(5n)];
    expect(pickClaimCoins(a, 25n)[0]!.token!.amount).toBe(40n);
    const tie = [c(50n), c(50n)];
    expect(pickClaimCoins([...tie].reverse(), 25n)[0]!.txid).toBe(pickClaimCoins(tie, 25n)[0]!.txid); // ties by outpoint, any order
    expect(pickClaimCoins([c(10n), c(10n), c(10n)], 25n)).toHaveLength(3);
    expect(pickClaimCoins([c(10n), c(10n)], 25n)).toEqual([]);
  });

  it('every attempt reads the coins before the history, so a claim seen in the coin read is in the later history read', async () => {
    const { chain, cfg } = setup();
    chain.failNext = ['txn-mempool-conflict'];
    await claimStarter(chain, cfg, judge(1));
    // two attempts: utxos, history, (raw txs), utxos, history
    const firstReads = chain.calls.filter((c, k) => k === 0 || chain.calls[k - 1] !== c);
    expect(firstReads.slice(0, 4)).toEqual(['utxos', 'history', 'utxos', 'history']);
  });

  it('an operator consolidation back to the faucet does not use a daily slot', async () => {
    const { chain, cfg, faucet } = setup({ coins: [100n, 100n], cfg: { dailyCap: 1 } });
    const coins = (await chain.getUtxos(faucet.tokenAddress)).filter((u) => u.token);
    const bch = (await chain.getUtxos(faucet.tokenAddress)).filter((u) => !u.token);
    const hex = new TransactionBuilder({ provider: chain })
      .addInputs([...coins, ...bch], new SignatureTemplate(faucet.priv).unlockP2PKH())
      .addOutput({ to: faucet.tokenAddress, amount: 1000n, token: { category: CAT, amount: 200n } })
      .addOutput({ to: faucet.address, amount: 50_000n })
      .build();
    await chain.sendRawTransaction(hex);
    await expect(claimStarter(chain, cfg, judge(1))).resolves.toBeTruthy();
    await expect(claimStarter(chain, cfg, judge(2))).rejects.toMatchObject({ code: 'DAILY_CAP' });
  });

  it('a forged faucet spend (a P2SH coin whose redeem script just pushes the faucet pubkey) is VM-valid but is not a claim', async () => {
    const { chain, cfg, faucet } = setup({ cfg: { dailyCap: 1 } });
    const redeem = Uint8Array.of(0x21, ...faucet.pub); // OP_PUSHBYTES_33 <faucetPub>: leaves one truthy item, no signature
    const p2sh = Uint8Array.of(0xa9, 0x14, ...hash160(redeem), 0x87);
    const prevTxid = 'cd'.repeat(32);
    chain.funding.set(prevTxid, fundingTxHex({ vout: 0 }, p2sh));
    const forgedTx = {
      version: 2, locktime: 0,
      inputs: [{ outpointTransactionHash: hexToBin(prevTxid), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x22, ...redeem) }],
      outputs: [{ lockingBytecode: lockingBytecodeOf(faucet.tokenAddress), valueSatoshis: 1000n }],
    };
    // the attack is real: the spend validates in the BCH 2026 VM (consensus) and its unlock ends with <21 faucetPub>
    expect(createVirtualMachineBch2026(false).verify({ transaction: forgedTx, sourceOutputs: [{ lockingBytecode: p2sh, valueSatoshis: 2000n }] })).toBe(true);
    const forgedTxid = 'ef'.repeat(32);
    chain.funding.set(forgedTxid, binToHex(encodeTransaction(forgedTx)));
    chain.sent.push(forgedTxid); // a donation to the faucet: it enters the faucet's history
    await expect(claimStarter(chain, cfg, judge(1))).resolves.toBeTruthy(); // the forged tx did not take the one daily slot
  });

  it('race: a retry after a coin conflict re-reads the history, so a competing claim for the same address wins once', async () => {
    const { chain, cfg } = setup({ coins: [300n, 300n] }); // two covering coins: the pick must still be the same coin
    chain.failNext = ['txn-mempool-conflict'];
    chain.beforeFail = () => claimStarter(chain, cfg, judge(1)); // the other request broadcasts first
    await expect(claimStarter(chain, cfg, judge(1))).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    expect(chain.sent).toHaveLength(1);
  });

  it('race: a retry after a coin conflict re-checks the daily cap, so the last slot is taken once', async () => {
    const { chain, cfg } = setup({ coins: [300n], cfg: { dailyCap: 2 } });
    await claimStarter(chain, cfg, judge(1));
    chain.failNext = ['txn-mempool-conflict'];
    chain.beforeFail = () => claimStarter(chain, cfg, judge(2)); // takes the last slot while ours is in flight
    await expect(claimStarter(chain, cfg, judge(3))).rejects.toMatchObject({ code: 'DAILY_CAP' });
    expect(chain.sent).toHaveLength(2);
  });

  it('StarterError is a named error class', () => {
    expect(new StarterError('BUSY', 'x').name).toBe('StarterError');
  });
});
