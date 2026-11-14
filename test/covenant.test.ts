// Every covenant rule (R1–R8) on the compiled artifact: the honest shape passes, each violation is rejected by the VM.
import { describe, expect, it } from 'vitest';
import { SignatureTemplate, TransactionBuilder, randomUtxo, type Output, type SpendableUtxo } from 'cashscript';
import { setup, pusd, FOREIGN, key } from './helpers';
import { buildSponsoredSend } from '../src/core/sponsoredSend';
import { signWcTransaction } from '../src/core/headlessSigner';
import { toWizardRequest, verifySignedTx } from '../src/core/wizard';

const F = 1n;

/** Hand-built variant of the sponsored shape, the user input signed directly, so one field at a time can break. */
function handBuilt(
  s: ReturnType<typeof setup>,
  o: {
    user?: SpendableUtxo;
    lane?: SpendableUtxo;
    extraInputs?: SpendableUtxo[];
    poolFirst?: boolean;
    outputs?: (d: { user: SpendableUtxo; lane: SpendableUtxo }) => Output[];
  } = {},
) {
  const user = o.user ?? s.addUserCoin(100n, 1000n);
  const lane = o.lane ?? s.addLane();
  const userUnlock = new SignatureTemplate(s.user.priv).unlockP2PKH();
  const b = new TransactionBuilder({ provider: s.provider, allowImplicitFungibleTokenBurn: true });
  if (o.poolFirst) b.addInput(lane, s.pool.unlock.sponsorPaid()).addInput(user, userUnlock);
  else b.addInput(user, userUnlock).addInput(lane, s.pool.unlock.sponsorPaid());
  for (const x of o.extraInputs ?? []) b.addInput(x, userUnlock);
  const outs = o.outputs
    ? o.outputs({ user, lane })
    : [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 10n - F) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1000n - 600n, token: pusd(lane.token!.amount + F) },
      ];
  b.addOutputs(outs);
  return b;
}

describe('FeePassPool covenant — honest path', () => {
  it('a sponsored send built by buildSponsoredSend, signed with sighash 0x61, is accepted by the VM', async () => {
    const s = setup();
    const send = buildSponsoredSend({
      pool: s.pool, params: s.params, categoryDisplay: pusd(0n).category,
      userUtxo: s.addUserCoin(100n, 1000n), userAddress: s.user.tokenAddress,
      lane: s.addLane(), recipient: s.payee.tokenAddress, amount: 10n,
    });
    const req = toWizardRequest(send, { pathName: 'receive', addressIndex: 0 });
    const signed = signWcTransaction(req.wire, new Map([[0, s.user.priv]]));
    const v = verifySignedTx(signed, req.proposed, s.user.lock);
    const txid = await s.provider.sendRawTransaction(signed);
    expect(txid).toBe(v.txid);
    expect(v.sighashType).toBe(0x61);
  });

  it('hand-built honest shape passes debug()', () => {
    const s = setup();
    expect(() => handBuilt(s).debug()).not.toThrow();
  });

  it('a top-up of exactly maxTopUp passes (R6 boundary)', () => {
    const s = setup();
    const user = s.addUserCoin(100n, 1000n);
    const b = handBuilt(s, {
      user,
      outputs: ({ lane }) => [
        { to: s.payee.tokenAddress, amount: 1000n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 675n, token: pusd(89n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 675n - 1000n, token: pusd(2n) },
      ],
    });
    expect(() => b.debug()).not.toThrow();
  });

  it('a lane can lose exactly maxSubsidy (R4 boundary)', () => {
    const s = setup();
    const b = handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 700n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 700n, token: pusd(89n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 2000n, token: pusd(2n) },
      ],
    });
    expect(() => b.debug()).not.toThrow();
  });

  it('the owner can withdraw a lane with its key (withdraw)', () => {
    const s = setup();
    const lane = s.addLane();
    const b = new TransactionBuilder({ provider: s.provider })
      .addInput(lane, s.pool.unlock.withdraw(new SignatureTemplate(s.owner.priv)))
      .addOutput({ to: s.owner.tokenAddress, amount: lane.satoshis - 500n, token: lane.token });
    expect(() => b.debug()).not.toThrow();
  });
});

describe('FeePassPool covenant — every rule rejects its violation', () => {
  const cases: [string, (s: ReturnType<typeof setup>) => TransactionBuilder, RegExp][] = [
    ['R1 three inputs', (s) => handBuilt(s, { extraInputs: [s.addUserCoin(0n, 5000n, null)] }), /inputs\.length == 2/],
    ['R1 four outputs', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 11n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 2000n, token: pusd(2n) },
        { to: s.user.address, amount: 600n },
      ] }), /outputs\.length == 3/],
    ['R1 pool not at input 1', (s) => handBuilt(s, { poolFirst: true }), /activeInputIndex == 1/],
    ['R7 token-less lane', (s) => handBuilt(s, {
      lane: s.addLane(100_000n, 0n, null),
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 11n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(1n) },
      ] }), /inputs\[1\]\.tokenCategory == pusdCategory/],
    ['R7 lane with a foreign token', (s) => handBuilt(s, {
      lane: s.addLane(100_000n, 0n, { category: FOREIGN, amount: 5n }),
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 11n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(1n) },
      ] }), /inputs\[1\]\.tokenCategory == pusdCategory/],
    ['R2 user input not PUSD', (s) => handBuilt(s, {
      user: s.addUserCoin(0n, 5000n, { category: FOREIGN, amount: 100n }),
      outputs: ({ lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: { category: FOREIGN, amount: 10n } },
        { to: s.user.tokenAddress, amount: 800n, token: { category: FOREIGN, amount: 90n } },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(1n) },
      ] }), /inputs\[0\]\.tokenCategory == pusdCategory/],
    ['R2 recipient output carries no PUSD', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.address, amount: 800n },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - F) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(2n) },
      ] }), /outputs\[0\]\.tokenCategory == pusdCategory/],
    ['R8 user change peeled into plain BCH', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(user.token!.amount - F) },
        { to: s.user.address, amount: 800n },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(2n) },
      ] }), /outputs\[1\]\.tokenCategory == pusdCategory/],
    ['R3 lane change sent elsewhere', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 11n) },
        { to: s.user.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(2n) },
      ] }), /outputs\[2\]\.lockingBytecode == tx\.inputs\[1\]\.lockingBytecode/],
    ['R4 lane loses maxSubsidy + 1', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 700n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 700n, token: pusd(89n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 2001n, token: pusd(2n) },
      ] }), /outputs\[2\]\.value >= tx\.inputs\[1\]\.value - maxSubsidy/],
    ['R5 pool receives f - 1 (nothing)', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 10n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(1n) },
      ] }), /outputs\[2\]\.tokenAmount == tx\.inputs\[1\]\.tokenAmount \+ feeTokens/],
    ['R5 pool receives f + 1 (overcharge)', (s) => handBuilt(s, {
      outputs: ({ user, lane }) => [
        { to: s.payee.tokenAddress, amount: 800n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 800n, token: pusd(user.token!.amount - 12n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 1600n, token: pusd(3n) },
      ] }), /outputs\[2\]\.tokenAmount == tx\.inputs\[1\]\.tokenAmount \+ feeTokens/],
    ['R6 user outputs exceed input + maxTopUp by 1', (s) => handBuilt(s, {
      outputs: ({ lane }) => [
        { to: s.payee.tokenAddress, amount: 1000n, token: pusd(10n) },
        { to: s.user.tokenAddress, amount: 676n, token: pusd(89n) },
        { to: s.pool.tokenAddress, amount: lane.satoshis - 676n - 1000n, token: pusd(2n) },
      ] }), /outputs\[0\]\.value \+ tx\.outputs\[1\]\.value/],
  ];

  for (const [name, build, rule] of cases) {
    it(name, () => {
      const s = setup();
      expect(() => build(s).debug()).toThrow(rule);
    });
  }

  it('withdraw with a non-owner key is rejected', () => {
    const s = setup();
    const lane = s.addLane();
    const b = new TransactionBuilder({ provider: s.provider })
      .addInput(lane, s.pool.unlock.withdraw(new SignatureTemplate(key('thief').priv)))
      .addOutput({ to: s.user.tokenAddress, amount: lane.satoshis - 500n, token: lane.token });
    expect(() => b.debug()).toThrow(/checkSig/);
  });

  it('a lane spent once cannot be spent again (second send on the same lane fails)', async () => {
    const s = setup();
    const lane = s.addLane();
    const mk = (coin: SpendableUtxo) => {
      const send = buildSponsoredSend({ pool: s.pool, params: s.params, categoryDisplay: pusd(0n).category,
        userUtxo: coin, userAddress: s.user.tokenAddress, lane, recipient: s.payee.tokenAddress, amount: 10n });
      const req = toWizardRequest(send, { pathName: 'receive', addressIndex: 0 });
      return signWcTransaction(req.wire, new Map([[0, s.user.priv]]));
    };
    const a = mk(s.addUserCoin(100n)); const b = mk(s.addUserCoin(100n));
    await s.provider.sendRawTransaction(a);
    await expect(s.provider.sendRawTransaction(b)).rejects.toThrow();
  });
});

void randomUtxo;
